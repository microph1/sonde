//! A [`Sink`] that writes OTLP batches into ClickHouse.
//!
//! One `INSERT` per table per batch: exporters already batch on their side, so
//! adding another buffering layer here would only widen the window in which an
//! acknowledged batch can be lost.

pub mod rows;
pub mod schema;
pub mod value;

use crate::config::ClickHouseConfig;
use crate::sink::{Sink, SinkError};
use async_trait::async_trait;
use clickhouse::{Client, RowOwned, RowWrite};
use opentelemetry_proto::tonic::collector::logs::v1::{
    ExportLogsServiceRequest, ExportLogsServiceResponse,
};
use opentelemetry_proto::tonic::collector::metrics::v1::{
    ExportMetricsServiceRequest, ExportMetricsServiceResponse,
};
use opentelemetry_proto::tonic::collector::trace::v1::{
    ExportTraceServiceRequest, ExportTraceServiceResponse,
};

pub struct ClickHouseSink {
    client: Client,
}

impl ClickHouseSink {
    /// Connects, verifies the server answers, and optionally creates the tables.
    pub async fn connect(config: &ClickHouseConfig) -> anyhow::Result<Self> {
        let client = Client::default()
            .with_url(&config.url)
            .with_user(&config.user)
            .with_password(&config.password)
            .with_database(&config.database);

        if config.create_schema {
            // The database itself cannot be created through a client already
            // scoped to it, so this one statement runs unscoped.
            let bootstrap = Client::default()
                .with_url(&config.url)
                .with_user(&config.user)
                .with_password(&config.password);
            bootstrap
                .query(&format!(
                    "CREATE DATABASE IF NOT EXISTS {}",
                    config.database
                ))
                .execute()
                .await?;

            for statement in schema::statements(config.ttl_days) {
                client.query(&statement).execute().await?;
            }
            tracing::info!(database = %config.database, "clickhouse schema ready");
        }

        client.query("SELECT 1").execute().await?;
        tracing::info!(url = %config.url, database = %config.database, "clickhouse connected");

        Ok(Self { client })
    }

    async fn insert<T>(&self, table: &str, rows: Vec<T>) -> Result<(), SinkError>
    where
        T: RowOwned + RowWrite,
    {
        if rows.is_empty() {
            return Ok(());
        }

        let count = rows.len();
        let mut insert = self.client.insert::<T>(table).await.map_err(sink_error)?;
        for row in rows {
            insert.write(&row).await.map_err(sink_error)?;
        }
        insert.end().await.map_err(sink_error)?;

        tracing::debug!(table, rows = count, "inserted");
        Ok(())
    }
}

/// Anything that could be a transient server or network problem is reported as
/// retryable; a schema or encoding fault would fail identically on retry, so it
/// is surfaced as an error the exporter should not repeat.
fn sink_error(error: clickhouse::error::Error) -> SinkError {
    use clickhouse::error::Error;

    match error {
        Error::Network(_) | Error::TimedOut => {
            tracing::warn!(%error, "clickhouse unavailable");
            SinkError::Unavailable
        }
        other => SinkError::Internal(anyhow::Error::new(other)),
    }
}

#[async_trait]
impl Sink for ClickHouseSink {
    async fn export_traces(
        &self,
        request: ExportTraceServiceRequest,
    ) -> Result<ExportTraceServiceResponse, SinkError> {
        self.insert(schema::TRACES, rows::trace_rows(request))
            .await?;
        Ok(ExportTraceServiceResponse::default())
    }

    async fn export_metrics(
        &self,
        request: ExportMetricsServiceRequest,
    ) -> Result<ExportMetricsServiceResponse, SinkError> {
        let rows = rows::metric_rows(request);

        if !rows.unsupported.is_empty() {
            // Not silent: these points are dropped because no table models them
            // yet, and the batch is still acknowledged as successful.
            tracing::warn!(
                instruments = ?rows.unsupported,
                "dropped metric points of unsupported instrument types"
            );
        }

        self.insert(schema::METRICS_GAUGE, rows.gauges).await?;
        self.insert(schema::METRICS_SUM, rows.sums).await?;
        self.insert(schema::METRICS_HISTOGRAM, rows.histograms)
            .await?;

        Ok(ExportMetricsServiceResponse::default())
    }

    async fn export_logs(
        &self,
        request: ExportLogsServiceRequest,
    ) -> Result<ExportLogsServiceResponse, SinkError> {
        self.insert(schema::LOGS, rows::log_rows(request)).await?;
        Ok(ExportLogsServiceResponse::default())
    }
}
