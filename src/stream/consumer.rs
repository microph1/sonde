//! The consumer side: drains the topics into storage.
//!
//! Messages are accumulated into time- or size-bounded batches before being
//! written, because ClickHouse penalises frequent small inserts with part
//! churn. Offsets are committed only after a batch is stored, which makes
//! delivery at-least-once: a crash between the insert and the commit replays
//! that batch.

use std::sync::Arc;
use std::time::Duration;

use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::logs::v1::ResourceLogs;
use opentelemetry_proto::tonic::metrics::v1::ResourceMetrics;
use opentelemetry_proto::tonic::trace::v1::ResourceSpans;
use prost::Message as _;
use rdkafka::ClientConfig;
use rdkafka::consumer::{CommitMode, Consumer as _, StreamConsumer};
use rdkafka::message::Message as _;
use tokio_util::sync::CancellationToken;

use crate::config::KafkaConfig;
use crate::sink::{Sink, SinkError};
use crate::stream::topics::Signal;

pub struct Consumer {
    consumer: StreamConsumer,
    sink: Arc<dyn Sink>,
    max_messages: usize,
    max_wait: Duration,
    retry_backoff: Duration,
}

impl Consumer {
    pub async fn connect(config: &KafkaConfig, sink: Arc<dyn Sink>) -> anyhow::Result<Self> {
        crate::stream::admin::ensure_topics(config).await?;

        let consumer: StreamConsumer = ClientConfig::new()
            .set("bootstrap.servers", &config.brokers)
            .set("group.id", &config.group_id)
            // Offsets move only once a batch is in storage, so auto-commit —
            // which advances on poll — would turn a crash into data loss.
            .set("enable.auto.commit", "false")
            .set("auto.offset.reset", "earliest")
            .set(
                "fetch.message.max.bytes",
                config.max_message_bytes.to_string(),
            )
            .create()?;

        let topics: Vec<String> = Signal::ALL
            .iter()
            .map(|signal| signal.topic(&config.topic_prefix))
            .collect();
        let topic_refs: Vec<&str> = topics.iter().map(String::as_str).collect();
        consumer.subscribe(&topic_refs)?;

        tracing::info!(brokers = %config.brokers, group = %config.group_id, ?topics, "kafka consumer ready");

        Ok(Self {
            consumer,
            sink,
            max_messages: config.batch_messages,
            max_wait: Duration::from_millis(config.batch_wait_ms),
            retry_backoff: Duration::from_millis(config.retry_backoff_ms),
        })
    }

    pub async fn run(&self, shutdown: CancellationToken) -> anyhow::Result<()> {
        loop {
            let mut batch = Batch::default();
            let deadline = tokio::time::Instant::now() + self.max_wait;

            while batch.messages < self.max_messages {
                tokio::select! {
                    // Only race the clock once something is waiting; an idle
                    // consumer should block on `recv`, not spin.
                    _ = tokio::time::sleep_until(deadline), if batch.messages > 0 => break,
                    _ = shutdown.cancelled() => {
                        self.flush(batch).await?;
                        tracing::info!("consumer stopped");
                        return Ok(());
                    }
                    message = self.consumer.recv() => {
                        match message {
                            Ok(message) => batch.add(&message),
                            // `recv` also reports client-level conditions such as a
                            // topic that has not been created yet or a broker that
                            // went away. None of those mean this consumer is done.
                            Err(error) => {
                                tracing::warn!(%error, "consumer error, continuing");
                                tokio::time::sleep(self.retry_backoff).await;
                            }
                        }
                    }
                }
            }

            self.flush(batch).await?;
        }
    }

    async fn flush(&self, batch: Batch) -> anyhow::Result<()> {
        if batch.messages == 0 {
            return Ok(());
        }

        let messages = batch.messages;
        self.store(batch).await?;
        self.consumer.commit_consumer_state(CommitMode::Sync)?;
        tracing::debug!(messages, "batch stored and committed");

        Ok(())
    }

    /// Retries while the sink reports backpressure; a fault that would fail the
    /// same way on replay stops the consumer instead of dropping the batch.
    async fn store(&self, batch: Batch) -> anyhow::Result<()> {
        loop {
            match self.write(&batch).await {
                Ok(()) => return Ok(()),
                Err(SinkError::Unavailable) => {
                    tracing::warn!(
                        backoff_ms = self.retry_backoff.as_millis(),
                        "storage unavailable, retrying batch"
                    );
                    tokio::time::sleep(self.retry_backoff).await;
                }
                Err(SinkError::Internal(error)) => {
                    return Err(error.context(
                        "storing a batch failed in a way that would repeat on replay; \
                         offsets were not committed",
                    ));
                }
            }
        }
    }

    async fn write(&self, batch: &Batch) -> Result<(), SinkError> {
        if !batch.spans.is_empty() {
            self.sink
                .export_traces(ExportTraceServiceRequest {
                    resource_spans: batch.spans.clone(),
                })
                .await?;
        }
        if !batch.metrics.is_empty() {
            self.sink
                .export_metrics(ExportMetricsServiceRequest {
                    resource_metrics: batch.metrics.clone(),
                })
                .await?;
        }
        if !batch.logs.is_empty() {
            self.sink
                .export_logs(ExportLogsServiceRequest {
                    resource_logs: batch.logs.clone(),
                })
                .await?;
        }
        Ok(())
    }
}

/// Messages decoded and merged back into one request per signal.
#[derive(Default)]
struct Batch {
    messages: usize,
    spans: Vec<ResourceSpans>,
    metrics: Vec<ResourceMetrics>,
    logs: Vec<ResourceLogs>,
}

impl Batch {
    fn add(&mut self, message: &rdkafka::message::BorrowedMessage<'_>) {
        self.messages += 1;

        let topic = message.topic();
        let Some(signal) = Signal::from_topic(topic) else {
            tracing::error!(topic, "message from an unexpected topic, skipped");
            return;
        };

        let Some(payload) = message.payload() else {
            tracing::warn!(topic, offset = message.offset(), "empty message");
            return;
        };

        let decoded = match signal {
            Signal::Traces => ExportTraceServiceRequest::decode(payload)
                .map(|r| self.spans.extend(r.resource_spans)),
            Signal::Metrics => ExportMetricsServiceRequest::decode(payload)
                .map(|r| self.metrics.extend(r.resource_metrics)),
            Signal::Logs => {
                ExportLogsServiceRequest::decode(payload).map(|r| self.logs.extend(r.resource_logs))
            }
        };

        if let Err(error) = decoded {
            // Undecodable bytes will never decode; skipping is the only way
            // forward, so it is logged loudly rather than counted silently.
            tracing::error!(
                %error,
                topic,
                partition = message.partition(),
                offset = message.offset(),
                "undecodable message skipped"
            );
        }
    }
}
