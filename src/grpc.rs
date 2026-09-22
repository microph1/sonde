use std::net::SocketAddr;
use std::sync::Arc;

use opentelemetry_proto::tonic::collector::{
    logs::v1::{
        ExportLogsServiceRequest, ExportLogsServiceResponse,
        logs_service_server::{LogsService, LogsServiceServer},
    },
    metrics::v1::{
        ExportMetricsServiceRequest, ExportMetricsServiceResponse,
        metrics_service_server::{MetricsService, MetricsServiceServer},
    },
    trace::v1::{
        ExportTraceServiceRequest, ExportTraceServiceResponse,
        trace_service_server::{TraceService, TraceServiceServer},
    },
};
use tokio_util::sync::CancellationToken;
use tonic::codec::CompressionEncoding;
use tonic::{Request, Response, Status, transport::Server};

use crate::ingest_auth::{ApiKeys, App, bearer};
use crate::sink::{Sink, SinkError};
use crate::stamp;

#[derive(Clone)]
struct GrpcReceiver {
    sink: Arc<dyn Sink>,
    keys: Option<Arc<ApiKeys>>,
}

impl GrpcReceiver {
    /// gRPC carries the credential in metadata rather than a header, and has no
    /// Origin — a browser cannot speak OTLP/gRPC, so only secret keys arrive
    /// here.
    async fn authenticate<T>(&self, request: &Request<T>) -> Result<Option<App>, Status> {
        let Some(keys) = &self.keys else {
            return Ok(None);
        };

        let token = request
            .metadata()
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .map(bearer);

        match keys.authenticate(token, None).await {
            Ok(app) => Ok(Some(app)),
            Err(rejection) => {
                tracing::warn!(reason = rejection.message(), "rejected batch");
                Err(Status::unauthenticated(rejection.message()))
            }
        }
    }
}

#[tonic::async_trait]
impl TraceService for GrpcReceiver {
    async fn export(
        &self,
        request: Request<ExportTraceServiceRequest>,
    ) -> Result<Response<ExportTraceServiceResponse>, Status> {
        let app = self.authenticate(&request).await?;
        let mut request = request.into_inner();

        if let Some(app) = &app {
            stamp::traces(&mut request, app);
        }

        self.sink
            .export_traces(request)
            .await
            .map(Response::new)
            .map_err(status_from)
    }
}

#[tonic::async_trait]
impl MetricsService for GrpcReceiver {
    async fn export(
        &self,
        request: Request<ExportMetricsServiceRequest>,
    ) -> Result<Response<ExportMetricsServiceResponse>, Status> {
        let app = self.authenticate(&request).await?;
        let mut request = request.into_inner();

        if let Some(app) = &app {
            stamp::metrics(&mut request, app);
        }

        self.sink
            .export_metrics(request)
            .await
            .map(Response::new)
            .map_err(status_from)
    }
}

#[tonic::async_trait]
impl LogsService for GrpcReceiver {
    async fn export(
        &self,
        request: Request<ExportLogsServiceRequest>,
    ) -> Result<Response<ExportLogsServiceResponse>, Status> {
        let app = self.authenticate(&request).await?;
        let mut request = request.into_inner();

        if let Some(app) = &app {
            stamp::logs(&mut request, app);
        }

        self.sink
            .export_logs(request)
            .await
            .map(Response::new)
            .map_err(status_from)
    }
}

/// OTLP tells exporters to retry on `UNAVAILABLE` and to drop on anything else,
/// so the mapping here decides whether a batch survives a sink failure.
fn status_from(error: SinkError) -> Status {
    match error {
        SinkError::Unavailable => Status::unavailable(error.to_string()),
        SinkError::Internal(error) => {
            tracing::error!(%error, "sink failed");
            Status::internal("internal error")
        }
    }
}

pub async fn serve(
    addr: SocketAddr,
    sink: Arc<dyn Sink>,
    keys: Option<Arc<ApiKeys>>,
    shutdown: CancellationToken,
) -> anyhow::Result<()> {
    let receiver = GrpcReceiver { sink, keys };

    tracing::info!(%addr, "otlp/grpc listening");
    Server::builder()
        .add_service(compressible(TraceServiceServer::new(receiver.clone())))
        .add_service(compressible(MetricsServiceServer::new(receiver.clone())))
        .add_service(compressible(LogsServiceServer::new(receiver)))
        .serve_with_shutdown(addr, shutdown.cancelled_owned())
        .await?;

    tracing::info!("otlp/grpc stopped");
    Ok(())
}

/// Exporters gzip by default once batches get large; advertise it both ways.
fn compressible<T>(service: T) -> T
where
    T: CompressionExt,
{
    service
        .accept_compressed(CompressionEncoding::Gzip)
        .send_compressed(CompressionEncoding::Gzip)
}

/// The generated servers each have inherent `accept_compressed`/`send_compressed`
/// methods but share no trait, so `compressible` needs one of its own.
trait CompressionExt: Sized {
    fn accept_compressed(self, encoding: CompressionEncoding) -> Self;
    fn send_compressed(self, encoding: CompressionEncoding) -> Self;
}

macro_rules! impl_compression_ext {
    ($($server:ident),* $(,)?) => {
        $(impl<T> CompressionExt for $server<T> {
            fn accept_compressed(self, encoding: CompressionEncoding) -> Self {
                $server::accept_compressed(self, encoding)
            }
            fn send_compressed(self, encoding: CompressionEncoding) -> Self {
                $server::send_compressed(self, encoding)
            }
        })*
    };
}

impl_compression_ext!(TraceServiceServer, MetricsServiceServer, LogsServiceServer);
