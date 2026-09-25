//! Receiver → Redpanda → consumer → ClickHouse, over real infrastructure.
//!
//! Skipped unless both `SONDE_TEST_KAFKA_BROKERS` and
//! `SONDE_TEST_CLICKHOUSE_URL` are set.

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use clickhouse::Client;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{AnyValue, KeyValue, any_value};
use opentelemetry_proto::tonic::resource::v1::Resource;
use opentelemetry_proto::tonic::trace::v1::{ResourceSpans, ScopeSpans, Span, span};
use sonde::config::{ClickHouseConfig, KafkaConfig};
use sonde::sink::Sink;
use sonde::storage::clickhouse::{ClickHouseSink, schema};
use sonde::stream::consumer::Consumer;
use sonde::stream::kafka::KafkaSink;
use tokio_util::sync::CancellationToken;

struct Env {
    kafka: KafkaConfig,
    clickhouse: ClickHouseConfig,
}

impl Env {
    /// Topics, consumer group and database are all suffixed per run so repeated
    /// runs never replay each other's messages.
    fn new(name: &str) -> Option<Self> {
        let brokers = std::env::var("SONDE_TEST_KAFKA_BROKERS").ok()?;
        let url = std::env::var("SONDE_TEST_CLICKHOUSE_URL").ok()?;
        let unique = format!(
            "{name}_{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis()
        );

        Some(Self {
            kafka: KafkaConfig {
                brokers,
                topic_prefix: format!("test_{unique}"),
                group_id: format!("test_{unique}"),
                linger_ms: 5,
                send_timeout_ms: 10_000,
                max_message_bytes: 16 * 1024 * 1024,
                batch_messages: 10,
                batch_wait_ms: 200,
                retry_backoff_ms: 200,
                partitions: 1,
                replication: 1,
            },
            clickhouse: ClickHouseConfig {
                url,
                database: format!("sonde_test_{unique}"),
                user: std::env::var("SONDE_TEST_CLICKHOUSE_USER")
                    .unwrap_or_else(|_| "default".into()),
                password: std::env::var("SONDE_TEST_CLICKHOUSE_PASSWORD").unwrap_or_default(),
                // Fixtures use fixed past timestamps that a live TTL would expire.
                ttl_days: 0,
                create_schema: true,
            },
        })
    }

    fn client(&self) -> Client {
        Client::default()
            .with_url(&self.clickhouse.url)
            .with_user(&self.clickhouse.user)
            .with_password(&self.clickhouse.password)
            .with_database(&self.clickhouse.database)
    }

    async fn drop_database(&self) {
        let client = Client::default()
            .with_url(&self.clickhouse.url)
            .with_user(&self.clickhouse.user)
            .with_password(&self.clickhouse.password);
        let _ = client
            .query(&format!(
                "DROP DATABASE IF EXISTS {}",
                self.clickhouse.database
            ))
            .execute()
            .await;
    }

    /// Polls until the row lands, since the hop through the broker is async.
    async fn await_rows(&self, table: &str, expected: u64) -> u64 {
        let deadline = Instant::now() + Duration::from_secs(30);

        loop {
            let count = self
                .client()
                .query(&format!("SELECT count() FROM {table}"))
                .fetch_one::<u64>()
                .await
                .unwrap_or(0);

            if count >= expected || Instant::now() > deadline {
                return count;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
}

fn span_batch(service: &str, name: &str) -> ExportTraceServiceRequest {
    ExportTraceServiceRequest {
        resource_spans: vec![ResourceSpans {
            resource: Some(Resource {
                attributes: vec![KeyValue {
                    key: "service.name".into(),
                    value: Some(AnyValue {
                        value: Some(any_value::Value::StringValue(service.into())),
                    }),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            scope_spans: vec![ScopeSpans {
                spans: vec![Span {
                    trace_id: vec![0x7a; 16],
                    span_id: vec![0x7b; 8],
                    name: name.into(),
                    kind: span::SpanKind::Client as i32,
                    start_time_unix_nano: 1_700_000_000_000_000_000,
                    end_time_unix_nano: 1_700_000_000_500_000_000,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        }],
    }
}

macro_rules! require_env {
    ($name:literal) => {
        match Env::new($name) {
            Some(env) => env,
            None => {
                eprintln!(
                    "skipping: set SONDE_TEST_KAFKA_BROKERS and SONDE_TEST_CLICKHOUSE_URL"
                );
                return;
            }
        }
    };
}

#[tokio::test]
async fn a_published_batch_reaches_clickhouse() {
    let env = require_env!("pipeline");
    env.drop_database().await;

    let producer = KafkaSink::connect(&env.kafka).await.unwrap();
    producer
        .export_traces(span_batch("checkout", "GET /cart"))
        .await
        .expect("publish failed");

    let storage = ClickHouseSink::connect(&env.clickhouse).await.unwrap();
    let consumer = Consumer::connect(&env.kafka, Arc::new(storage))
        .await
        .unwrap();
    let shutdown = CancellationToken::new();
    let running = tokio::spawn({
        let shutdown = shutdown.clone();
        async move { consumer.run(shutdown).await }
    });

    assert_eq!(env.await_rows(schema::TRACES, 1).await, 1);

    let (service, name, kind) = env
        .client()
        .query(&format!(
            "SELECT ServiceName, SpanName, SpanKind FROM {}",
            schema::TRACES
        ))
        .fetch_one::<(String, String, String)>()
        .await
        .unwrap();
    assert_eq!(service, "checkout");
    assert_eq!(name, "GET /cart");
    assert_eq!(kind, "Client");

    shutdown.cancel();
    running.await.unwrap().expect("consumer errored");

    env.drop_database().await;
}

#[tokio::test]
async fn the_consumer_replays_what_it_did_not_commit() {
    let env = require_env!("replay");
    env.drop_database().await;

    let producer = KafkaSink::connect(&env.kafka).await.unwrap();
    producer
        .export_traces(span_batch("api", "POST /orders"))
        .await
        .unwrap();

    // First pass: consume and store, then stop cleanly so offsets are committed.
    {
        let storage = ClickHouseSink::connect(&env.clickhouse).await.unwrap();
        let consumer = Consumer::connect(&env.kafka, Arc::new(storage))
            .await
            .unwrap();
        let shutdown = CancellationToken::new();
        let running = tokio::spawn({
            let shutdown = shutdown.clone();
            async move { consumer.run(shutdown).await }
        });

        assert_eq!(env.await_rows(schema::TRACES, 1).await, 1);
        shutdown.cancel();
        running.await.unwrap().unwrap();
    }

    // Second pass with the same group: the committed offset means no replay.
    {
        let storage = ClickHouseSink::connect(&env.clickhouse).await.unwrap();
        let consumer = Consumer::connect(&env.kafka, Arc::new(storage))
            .await
            .unwrap();
        let shutdown = CancellationToken::new();
        let running = tokio::spawn({
            let shutdown = shutdown.clone();
            async move { consumer.run(shutdown).await }
        });

        tokio::time::sleep(Duration::from_secs(3)).await;
        shutdown.cancel();
        running.await.unwrap().unwrap();
    }

    assert_eq!(env.await_rows(schema::TRACES, 1).await, 1);

    env.drop_database().await;
}
