use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use bytes::Bytes;
use opentelemetry_proto::tonic::collector::{
    logs::v1::ExportLogsServiceRequest, metrics::v1::ExportMetricsServiceRequest,
    trace::v1::ExportTraceServiceRequest,
};
use prost::Message;
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio_util::sync::CancellationToken;
use tower_http::cors::{AllowHeaders, AllowOrigin, CorsLayer};
use tower_http::decompression::RequestDecompressionLayer;

use crate::ingest_auth::{ApiKeys, App, bearer};
use crate::sink::{Sink, SinkError};
use crate::stamp;

/// Batches routinely exceed axum's 2 MiB default; the OTLP spec sets no limit,
/// so this is a guard against a runaway exporter rather than a protocol bound.
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

const PROTOBUF: &str = "application/x-protobuf";
const JSON: &str = "application/json";

pub async fn serve(
    addr: SocketAddr,
    sink: Arc<dyn Sink>,
    keys: Option<Arc<ApiKeys>>,
    cors_origins: &[String],
    shutdown: CancellationToken,
) -> anyhow::Result<()> {
    let app = router(sink, keys, cors_origins)?;
    let listener = tokio::net::TcpListener::bind(addr).await?;

    tracing::info!(%addr, "otlp/http listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown.cancelled_owned())
        .await?;

    tracing::info!("otlp/http stopped");
    Ok(())
}

/// Both the sink and the key set travel as state, so a handler can authenticate
/// without reaching for a global.
#[derive(Clone)]
struct Ingest {
    sink: Arc<dyn Sink>,
    keys: Option<Arc<ApiKeys>>,
}

pub fn router(
    sink: Arc<dyn Sink>,
    keys: Option<Arc<ApiKeys>>,
    cors_origins: &[String],
) -> anyhow::Result<Router> {
    let router = Router::new()
        .route("/v1/traces", post(export_traces))
        .route("/v1/metrics", post(export_metrics))
        .route("/v1/logs", post(export_logs))
        .route("/healthz", get(|| async { "ok" }))
        .layer(RequestDecompressionLayer::new().gzip(true))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES));

    let router = match cors(cors_origins)? {
        Some(layer) => router.layer(layer),
        None => router,
    };

    Ok(router.with_state(Ingest { sink, keys }))
}

/// Browsers exporting OTLP directly send `Content-Type: application/json`,
/// which is not a CORS-safelisted value, so every export is preceded by a
/// preflight. Without an allowed origin configured no CORS headers are sent at
/// all, which is the right default for a receiver reached only by backends.
fn cors(origins: &[String]) -> anyhow::Result<Option<CorsLayer>> {
    if origins.is_empty() {
        return Ok(None);
    }

    let allow_origin = if origins.iter().any(|origin| origin == "*") {
        AllowOrigin::any()
    } else {
        let values = origins
            .iter()
            .map(|origin| {
                HeaderValue::from_str(origin)
                    .with_context(|| format!("`{origin}` is not a valid origin"))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        AllowOrigin::list(values)
    };

    tracing::info!(?origins, "cors enabled");

    Ok(Some(
        CorsLayer::new()
            .allow_origin(allow_origin)
            .allow_methods([Method::POST, Method::OPTIONS])
            // Mirroring the requested headers rather than sending `*`: the
            // wildcard is defined not to cover `Authorization`, which browser
            // exporters do send, and none of this is credentialed anyway.
            .allow_headers(AllowHeaders::mirror_request()),
    ))
}

async fn export_traces(
    State(ingest): State<Ingest>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let encoding = Encoding::from_headers(&headers)?;
    let app = authenticate(&ingest.keys, &headers).await?;
    let mut request: ExportTraceServiceRequest = encoding.decode(&body)?;

    if let Some(app) = &app {
        stamp::traces(&mut request, app);
    }

    Ok(encoding.encode(ingest.sink.export_traces(request).await?))
}

async fn export_metrics(
    State(ingest): State<Ingest>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let encoding = Encoding::from_headers(&headers)?;
    let app = authenticate(&ingest.keys, &headers).await?;
    let mut request: ExportMetricsServiceRequest = encoding.decode(&body)?;

    if let Some(app) = &app {
        stamp::metrics(&mut request, app);
    }

    Ok(encoding.encode(ingest.sink.export_metrics(request).await?))
}

async fn export_logs(
    State(ingest): State<Ingest>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let encoding = Encoding::from_headers(&headers)?;
    let app = authenticate(&ingest.keys, &headers).await?;
    let mut request: ExportLogsServiceRequest = encoding.decode(&body)?;

    if let Some(app) = &app {
        stamp::logs(&mut request, app);
    }

    Ok(encoding.encode(ingest.sink.export_logs(request).await?))
}

/// OTLP/HTTP carries either binary protobuf or the protobuf JSON mapping, and
/// the response must come back in whichever the request used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Encoding {
    Protobuf,
    Json,
}

impl Encoding {
    fn from_headers(headers: &HeaderMap) -> Result<Self, ApiError> {
        let Some(value) = headers.get(header::CONTENT_TYPE) else {
            // Exporters are required to send one, but protobuf is the default
            // wire format so an omission is not worth rejecting the batch over.
            return Ok(Self::Protobuf);
        };
        let value = value.to_str().unwrap_or_default();
        // Strip any `; charset=…` parameter before matching.
        match value.split(';').next().unwrap_or_default().trim() {
            PROTOBUF => Ok(Self::Protobuf),
            JSON => Ok(Self::Json),
            other => Err(ApiError::UnsupportedMediaType(other.to_owned())),
        }
    }

    fn decode<T: Message + DeserializeOwned + Default>(self, body: &[u8]) -> Result<T, ApiError> {
        match self {
            Self::Protobuf => T::decode(body).map_err(|e| ApiError::Malformed(e.to_string())),
            Self::Json => {
                serde_json::from_slice(body).map_err(|e| ApiError::Malformed(e.to_string()))
            }
        }
    }

    fn encode<T: Message + Serialize>(self, response: T) -> Response {
        match self {
            Self::Protobuf => {
                ([(header::CONTENT_TYPE, PROTOBUF)], response.encode_to_vec()).into_response()
            }
            Self::Json => Json(response).into_response(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
enum ApiError {
    #[error("{0}")]
    Unauthorized(&'static str),
    #[error("unsupported content type: {0}")]
    UnsupportedMediaType(String),
    #[error("malformed payload: {0}")]
    Malformed(String),
    #[error("sink unavailable")]
    Unavailable,
    #[error("internal error")]
    Internal,
}

impl From<SinkError> for ApiError {
    fn from(error: SinkError) -> Self {
        match error {
            SinkError::Unavailable => Self::Unavailable,
            SinkError::Internal(error) => {
                tracing::error!(%error, "sink failed");
                Self::Internal
            }
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self {
            // 400 and 415 tell the exporter the batch is unsalvageable; 503 is
            // the only one it should retry.
            Self::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            Self::UnsupportedMediaType(_) => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Self::Malformed(_) => StatusCode::BAD_REQUEST,
            Self::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, self.to_string()).into_response()
    }
}

/// Authenticates a batch and returns the app it belongs to.
///
/// `None` means ingest auth is off, in which case nothing is stamped — an
/// unauthenticated batch has no app to attribute it to, and inventing one would
/// be worse than leaving the dimension empty.
async fn authenticate(
    keys: &Option<Arc<ApiKeys>>,
    headers: &HeaderMap,
) -> Result<Option<App>, ApiError> {
    let Some(keys) = keys else {
        return Ok(None);
    };

    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(bearer);

    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());

    match keys.authenticate(token, origin).await {
        Ok(app) => Ok(Some(app)),
        Err(rejection) => {
            tracing::warn!(reason = rejection.message(), "rejected batch");
            Err(ApiError::Unauthorized(rejection.message()))
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    use crate::sink::LoggingSink;

    use super::*;

    fn app() -> Router {
        router(Arc::new(LoggingSink::default()), None, &[]).unwrap()
    }

    fn app_with_cors(origins: &[&str]) -> Router {
        let origins: Vec<String> = origins.iter().map(|o| o.to_string()).collect();
        router(Arc::new(LoggingSink::default()), None, &origins).unwrap()
    }

    /// What a browser OTLP exporter actually sends before its first export.
    async fn preflight(app: Router, origin: &str) -> Response {
        app.oneshot(
            Request::builder()
                .method(Method::OPTIONS)
                .uri("/v1/traces")
                .header(header::ORIGIN, origin)
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .header(
                    header::ACCESS_CONTROL_REQUEST_HEADERS,
                    "content-type,authorization",
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn a_preflight_is_allowed_for_a_configured_origin() {
        let origin = "http://ai-memory.microgamma.localhost";
        let response = preflight(app_with_cors(&[origin]), origin).await;

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            origin
        );

        // `*` is defined not to cover Authorization, so it must be named.
        let allowed = response.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS]
            .to_str()
            .unwrap()
            .to_ascii_lowercase();
        assert!(allowed.contains("authorization"), "got `{allowed}`");
        assert!(allowed.contains("content-type"), "got `{allowed}`");
    }

    #[tokio::test]
    async fn an_unlisted_origin_gets_no_allow_header() {
        let response = preflight(
            app_with_cors(&["http://allowed.localhost"]),
            "http://evil.example",
        )
        .await;
        assert!(
            !response
                .headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        );
    }

    #[tokio::test]
    async fn a_wildcard_allows_any_origin() {
        let response = preflight(app_with_cors(&["*"]), "http://anything.localhost").await;
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    }

    #[tokio::test]
    async fn cors_is_off_unless_configured() {
        let response = preflight(app(), "http://ai-memory.microgamma.localhost").await;
        assert!(
            !response
                .headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        );
    }

    #[test]
    fn a_malformed_origin_is_rejected_at_startup() {
        let bad = vec!["http://\u{7f}bad".to_owned()];
        assert!(router(Arc::new(LoggingSink::default()), None, &bad).is_err());
    }

    #[test]
    fn content_type_parameters_are_ignored() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            "application/json; charset=utf-8".parse().unwrap(),
        );
        assert_eq!(Encoding::from_headers(&headers).unwrap(), Encoding::Json);
    }

    #[tokio::test]
    async fn accepts_protobuf_traces() {
        let body = ExportTraceServiceRequest::default().encode_to_vec();
        let response = app()
            .oneshot(
                Request::post("/v1/traces")
                    .header(header::CONTENT_TYPE, PROTOBUF)
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], PROTOBUF);
    }

    #[tokio::test]
    async fn accepts_json_logs_and_answers_in_json() {
        let response = app()
            .oneshot(
                Request::post("/v1/logs")
                    .header(header::CONTENT_TYPE, JSON)
                    .body(Body::from(r#"{"resourceLogs":[]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            response.headers()[header::CONTENT_TYPE]
                .to_str()
                .unwrap()
                .starts_with(JSON)
        );
    }

    #[tokio::test]
    async fn rejects_unknown_content_type() {
        let response = app()
            .oneshot(
                Request::post("/v1/metrics")
                    .header(header::CONTENT_TYPE, "text/plain")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }

    #[tokio::test]
    async fn rejects_malformed_protobuf() {
        let response = app()
            .oneshot(
                Request::post("/v1/traces")
                    .header(header::CONTENT_TYPE, PROTOBUF)
                    .body(Body::from(vec![0xff, 0xff, 0xff]))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
