//! The producer side: a [`Sink`] that publishes OTLP batches to the broker.

use std::time::Duration;

use async_trait::async_trait;
use opentelemetry_proto::tonic::collector::logs::v1::{
    ExportLogsServiceRequest, ExportLogsServiceResponse,
};
use opentelemetry_proto::tonic::collector::metrics::v1::{
    ExportMetricsServiceRequest, ExportMetricsServiceResponse,
};
use opentelemetry_proto::tonic::collector::trace::v1::{
    ExportTraceServiceRequest, ExportTraceServiceResponse,
};
use rdkafka::ClientConfig;
use rdkafka::producer::{FutureProducer, FutureRecord};
use rdkafka::util::Timeout;

use crate::config::KafkaConfig;
use crate::sink::{Sink, SinkError};
use crate::stream::topics::{self, Message, Signal};

pub struct KafkaSink {
    producer: FutureProducer,
    topic_prefix: String,
    send_timeout: Duration,
}

impl KafkaSink {
    pub async fn connect(config: &KafkaConfig) -> anyhow::Result<Self> {
        crate::stream::admin::ensure_topics(config).await?;

        let producer: FutureProducer = ClientConfig::new()
            .set("bootstrap.servers", &config.brokers)
            // Acknowledging an export means the data is durable. `acks=all`
            // is what makes that true rather than aspirational.
            .set("acks", "all")
            .set("enable.idempotence", "true")
            .set("compression.type", "lz4")
            .set("linger.ms", config.linger_ms.to_string())
            .set("message.max.bytes", config.max_message_bytes.to_string())
            .create()?;

        tracing::info!(brokers = %config.brokers, "kafka producer ready");

        Ok(Self {
            producer,
            topic_prefix: config.topic_prefix.clone(),
            send_timeout: Duration::from_millis(config.send_timeout_ms),
        })
    }

    /// Publishes every message, failing the export if any one of them fails.
    ///
    /// Sends are issued together and awaited together: `linger.ms` can only
    /// batch messages that are already queued, so awaiting each in turn would
    /// serialise the batch into one round trip per message.
    async fn publish(&self, signal: Signal, messages: Vec<Message>) -> Result<(), SinkError> {
        if messages.is_empty() {
            return Ok(());
        }

        let topic = signal.topic(&self.topic_prefix);
        let count = messages.len();

        let deliveries = messages.iter().map(|message| {
            self.producer.send(
                FutureRecord::to(&topic)
                    .key(&message.key)
                    .payload(&message.payload),
                Timeout::After(self.send_timeout),
            )
        });

        for delivery in futures_util::future::join_all(deliveries).await {
            if let Err((error, _)) = delivery {
                // A broker that is down, full, or slow is exactly the case the
                // exporter should retry rather than drop.
                tracing::warn!(%error, %topic, "publish failed");
                return Err(SinkError::Unavailable);
            }
        }

        tracing::debug!(%topic, messages = count, "published");
        Ok(())
    }
}

#[async_trait]
impl Sink for KafkaSink {
    async fn export_traces(
        &self,
        request: ExportTraceServiceRequest,
    ) -> Result<ExportTraceServiceResponse, SinkError> {
        self.publish(Signal::Traces, topics::split_traces(request))
            .await?;
        Ok(ExportTraceServiceResponse::default())
    }

    async fn export_metrics(
        &self,
        request: ExportMetricsServiceRequest,
    ) -> Result<ExportMetricsServiceResponse, SinkError> {
        self.publish(Signal::Metrics, topics::split_metrics(request))
            .await?;
        Ok(ExportMetricsServiceResponse::default())
    }

    async fn export_logs(
        &self,
        request: ExportLogsServiceRequest,
    ) -> Result<ExportLogsServiceResponse, SinkError> {
        self.publish(Signal::Logs, topics::split_logs(request))
            .await?;
        Ok(ExportLogsServiceResponse::default())
    }
}
