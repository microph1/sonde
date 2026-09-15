use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use opentelemetry_proto::tonic::collector::{
    logs::v1::{ExportLogsServiceRequest, ExportLogsServiceResponse},
    metrics::v1::{ExportMetricsServiceRequest, ExportMetricsServiceResponse},
    trace::v1::{ExportTraceServiceRequest, ExportTraceServiceResponse},
};

/// Where a receiver hands decoded OTLP payloads.
///
/// Both the gRPC and the HTTP receiver speak to this one trait, so a backend is
/// written once and is reachable over either transport. Partially rejected data
/// is reported through the `partial_success` field of the response rather than
/// as an error — a `SinkError` means the exporter should retry the whole batch.
#[async_trait]
pub trait Sink: Send + Sync + 'static {
    async fn export_traces(
        &self,
        request: ExportTraceServiceRequest,
    ) -> Result<ExportTraceServiceResponse, SinkError>;

    async fn export_metrics(
        &self,
        request: ExportMetricsServiceRequest,
    ) -> Result<ExportMetricsServiceResponse, SinkError>;

    async fn export_logs(
        &self,
        request: ExportLogsServiceRequest,
    ) -> Result<ExportLogsServiceResponse, SinkError>;
}

#[derive(Debug, thiserror::Error)]
pub enum SinkError {
    /// Backpressure: the exporter is expected to retry this batch later.
    #[error("sink is at capacity")]
    Unavailable,
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

/// Accepts everything and logs the shape of it. Stands in for a real backend
/// until one exists, and doubles as the reference implementation of `Sink`.
#[derive(Debug, Default)]
pub struct LoggingSink {
    spans: AtomicU64,
    metrics: AtomicU64,
    logs: AtomicU64,
}

impl LoggingSink {
    pub fn counts(&self) -> (u64, u64, u64) {
        (
            self.spans.load(Ordering::Relaxed),
            self.metrics.load(Ordering::Relaxed),
            self.logs.load(Ordering::Relaxed),
        )
    }
}

#[async_trait]
impl Sink for LoggingSink {
    async fn export_traces(
        &self,
        request: ExportTraceServiceRequest,
    ) -> Result<ExportTraceServiceResponse, SinkError> {
        let spans: usize = request
            .resource_spans
            .iter()
            .flat_map(|rs| &rs.scope_spans)
            .map(|ss| ss.spans.len())
            .sum();
        self.spans.fetch_add(spans as u64, Ordering::Relaxed);
        tracing::info!(
            resources = request.resource_spans.len(),
            spans,
            "accepted traces"
        );
        Ok(ExportTraceServiceResponse::default())
    }

    async fn export_metrics(
        &self,
        request: ExportMetricsServiceRequest,
    ) -> Result<ExportMetricsServiceResponse, SinkError> {
        let metrics: usize = request
            .resource_metrics
            .iter()
            .flat_map(|rm| &rm.scope_metrics)
            .map(|sm| sm.metrics.len())
            .sum();
        self.metrics.fetch_add(metrics as u64, Ordering::Relaxed);
        tracing::info!(
            resources = request.resource_metrics.len(),
            metrics,
            "accepted metrics"
        );
        Ok(ExportMetricsServiceResponse::default())
    }

    async fn export_logs(
        &self,
        request: ExportLogsServiceRequest,
    ) -> Result<ExportLogsServiceResponse, SinkError> {
        let records: usize = request
            .resource_logs
            .iter()
            .flat_map(|rl| &rl.scope_logs)
            .map(|sl| sl.log_records.len())
            .sum();
        self.logs.fetch_add(records as u64, Ordering::Relaxed);
        tracing::info!(
            resources = request.resource_logs.len(),
            records,
            "accepted logs"
        );
        Ok(ExportLogsServiceResponse::default())
    }
}

#[cfg(test)]
mod tests {
    use opentelemetry_proto::tonic::trace::v1::{ResourceSpans, ScopeSpans, Span};

    use super::*;

    #[tokio::test]
    async fn counts_spans_across_scopes() {
        let sink = LoggingSink::default();
        let request = ExportTraceServiceRequest {
            resource_spans: vec![ResourceSpans {
                scope_spans: vec![
                    ScopeSpans {
                        spans: vec![Span::default(), Span::default()],
                        ..Default::default()
                    },
                    ScopeSpans {
                        spans: vec![Span::default()],
                        ..Default::default()
                    },
                ],
                ..Default::default()
            }],
        };

        sink.export_traces(request).await.unwrap();
        assert_eq!(sink.counts().0, 3);
    }
}
