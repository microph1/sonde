use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode, header};
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
use tower_http::decompression::RequestDecompressionLayer;

use crate::sink::{Sink, SinkError};

/// Batches routinely exceed axum's 2 MiB default; the OTLP spec sets no limit,
/// so this is a guard against a runaway exporter rather than a protocol bound.
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

const PROTOBUF: &str = "application/x-protobuf";
const JSON: &str = "application/json";

pub async fn serve(
    addr: SocketAddr,
    sink: Arc<dyn Sink>,
    shutdown: CancellationToken,
) -> anyhow::Result<()> {
    let app = router(sink);
    let listener = tokio::net::TcpListener::bind(addr).await?;

    tracing::info!(%addr, "otlp/http listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown.cancelled_owned())
        .await?;

    tracing::info!("otlp/http stopped");
    Ok(())
}

pub fn router(sink: Arc<dyn Sink>) -> Router {
    Router::new()
        .route("/v1/traces", post(export_traces))
        .route("/v1/metrics", post(export_metrics))
        .route("/v1/logs", post(export_logs))
        .route("/healthz", get(|| async { "ok" }))
        .layer(RequestDecompressionLayer::new().gzip(true))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(sink)
}

async fn export_traces(
    State(sink): State<Arc<dyn Sink>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let encoding = Encoding::from_headers(&headers)?;
    let request: ExportTraceServiceRequest = encoding.decode(&body)?;
    Ok(encoding.encode(sink.export_traces(request).await?))
}

async fn export_metrics(
    State(sink): State<Arc<dyn Sink>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let encoding = Encoding::from_headers(&headers)?;
    let request: ExportMetricsServiceRequest = encoding.decode(&body)?;
    Ok(encoding.encode(sink.export_metrics(request).await?))
}

async fn export_logs(
    State(sink): State<Arc<dyn Sink>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let encoding = Encoding::from_headers(&headers)?;
    let request: ExportLogsServiceRequest = encoding.decode(&body)?;
    Ok(encoding.encode(sink.export_logs(request).await?))
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
            Self::UnsupportedMediaType(_) => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Self::Malformed(_) => StatusCode::BAD_REQUEST,
            Self::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, self.to_string()).into_response()
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
        router(Arc::new(LoggingSink::default()))
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
