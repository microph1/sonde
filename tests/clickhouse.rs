//! End-to-end checks against a real ClickHouse.
//!
//! Skipped unless `SONDE_TEST_CLICKHOUSE_URL` is set, because the row
//! structs are only validated against the server's own column types — the
//! client fetches them before every insert, so a schema drift shows up here and
//! nowhere in the unit tests.

use clickhouse::Client;
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{AnyValue, InstrumentationScope, KeyValue, any_value};
use opentelemetry_proto::tonic::logs::v1::{LogRecord, ResourceLogs, ScopeLogs};
use opentelemetry_proto::tonic::metrics::v1::{
    Gauge, Histogram, HistogramDataPoint, Metric, NumberDataPoint, ResourceMetrics, ScopeMetrics,
    Sum, Summary, metric::Data, number_data_point,
};
use opentelemetry_proto::tonic::resource::v1::Resource;
use opentelemetry_proto::tonic::trace::v1::{ResourceSpans, ScopeSpans, Span, Status, span};
use sonde::config::ClickHouseConfig;
use sonde::sink::Sink;
use sonde::storage::clickhouse::{ClickHouseSink, schema};

/// Each run gets its own database so repeated runs and parallel tests never
/// read each other's rows.
struct TestDb {
    config: ClickHouseConfig,
}

impl TestDb {
    fn new(name: &str) -> Option<Self> {
        let url = std::env::var("SONDE_TEST_CLICKHOUSE_URL").ok()?;
        Some(Self {
            config: ClickHouseConfig {
                url,
                database: format!("sonde_test_{name}"),
                user: std::env::var("SONDE_TEST_CLICKHOUSE_USER")
                    .unwrap_or_else(|_| "default".into()),
                password: std::env::var("SONDE_TEST_CLICKHOUSE_PASSWORD").unwrap_or_default(),
                // Retention off: the fixtures use fixed 2023 timestamps, which any
                // live TTL would expire between the insert and the assertions.
                ttl_days: 0,
                create_schema: true,
            },
        })
    }

    fn client(&self) -> Client {
        Client::default()
            .with_url(&self.config.url)
            .with_user(&self.config.user)
            .with_password(&self.config.password)
            .with_database(&self.config.database)
    }

    async fn drop_database(&self) {
        let client = Client::default()
            .with_url(&self.config.url)
            .with_user(&self.config.user)
            .with_password(&self.config.password);
        let _ = client
            .query(&format!("DROP DATABASE IF EXISTS {}", self.config.database))
            .execute()
            .await;
    }

    async fn count(&self, table: &str) -> u64 {
        self.client()
            .query(&format!("SELECT count() FROM {table}"))
            .fetch_one::<u64>()
            .await
            .unwrap_or_else(|e| panic!("counting {table}: {e}"))
    }

    async fn scalar<T>(&self, sql: &str) -> T
    where
        T: clickhouse::RowRead + for<'a> clickhouse::Row<Value<'a> = T> + 'static,
    {
        self.client()
            .query(sql)
            .fetch_one::<T>()
            .await
            .unwrap_or_else(|e| panic!("query `{sql}`: {e}"))
    }
}

macro_rules! require_clickhouse {
    ($name:literal) => {
        match TestDb::new($name) {
            Some(db) => db,
            None => {
                eprintln!("skipping: SONDE_TEST_CLICKHOUSE_URL is not set");
                return;
            }
        }
    };
}

fn string_attr(key: &str, value: &str) -> KeyValue {
    KeyValue {
        key: key.to_owned(),
        value: Some(AnyValue {
            value: Some(any_value::Value::StringValue(value.to_owned())),
        }),
        ..Default::default()
    }
}

fn resource(service: &str) -> Resource {
    Resource {
        attributes: vec![string_attr("service.name", service)],
        ..Default::default()
    }
}

fn scope() -> InstrumentationScope {
    InstrumentationScope {
        name: "test-scope".into(),
        version: "1.2.3".into(),
        ..Default::default()
    }
}

#[tokio::test]
async fn writes_traces_with_events_and_links() {
    let db = require_clickhouse!("traces");
    db.drop_database().await;
    let sink = ClickHouseSink::connect(&db.config).await.unwrap();

    let request = ExportTraceServiceRequest {
        resource_spans: vec![ResourceSpans {
            resource: Some(resource("checkout")),
            scope_spans: vec![ScopeSpans {
                scope: Some(scope()),
                spans: vec![Span {
                    trace_id: vec![0x11; 16],
                    span_id: vec![0x22; 8],
                    parent_span_id: vec![0x33; 8],
                    name: "POST /orders".into(),
                    kind: span::SpanKind::Server as i32,
                    start_time_unix_nano: 1_700_000_000_000_000_000,
                    end_time_unix_nano: 1_700_000_000_250_000_000,
                    attributes: vec![string_attr("http.method", "POST")],
                    events: vec![span::Event {
                        time_unix_nano: 1_700_000_000_100_000_000,
                        name: "exception".into(),
                        attributes: vec![string_attr("exception.type", "Timeout")],
                        ..Default::default()
                    }],
                    links: vec![span::Link {
                        trace_id: vec![0x44; 16],
                        span_id: vec![0x55; 8],
                        trace_state: "vendor=1".into(),
                        ..Default::default()
                    }],
                    status: Some(Status {
                        message: "boom".into(),
                        code: opentelemetry_proto::tonic::trace::v1::status::StatusCode::Error
                            as i32,
                    }),
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        }],
    };

    sink.export_traces(request).await.unwrap();

    assert_eq!(db.count(schema::TRACES).await, 1);

    let (service, kind, status, duration, event, link, http_method) = db
        .scalar::<(String, String, String, u64, String, String, String)>(&format!(
            "SELECT ServiceName, SpanKind, StatusCode, Duration,
                    EventsName[1], LinksTraceId[1], SpanAttributes['http.method']
             FROM {}",
            schema::TRACES
        ))
        .await;

    assert_eq!(service, "checkout");
    assert_eq!(kind, "Server");
    assert_eq!(status, "Error");
    assert_eq!(duration, 250_000_000);
    assert_eq!(event, "exception");
    assert_eq!(link, "44".repeat(16));
    assert_eq!(http_method, "POST");

    // The timestamp survives the DateTime64(9) round trip at nanosecond precision.
    let nanos = db
        .scalar::<i64>(&format!(
            "SELECT toUnixTimestamp64Nano(Timestamp) FROM {}",
            schema::TRACES
        ))
        .await;
    assert_eq!(nanos, 1_700_000_000_000_000_000);

    db.drop_database().await;
}

#[tokio::test]
async fn writes_logs() {
    let db = require_clickhouse!("logs");
    db.drop_database().await;
    let sink = ClickHouseSink::connect(&db.config).await.unwrap();

    let request = ExportLogsServiceRequest {
        resource_logs: vec![ResourceLogs {
            resource: Some(resource("worker")),
            scope_logs: vec![ScopeLogs {
                scope: Some(scope()),
                log_records: vec![LogRecord {
                    time_unix_nano: 1_700_000_000_000_000_000,
                    observed_time_unix_nano: 1_700_000_000_000_000_001,
                    severity_number: 17,
                    severity_text: "ERROR".into(),
                    body: Some(AnyValue {
                        value: Some(any_value::Value::StringValue("queue drained".into())),
                    }),
                    attributes: vec![string_attr("queue", "orders")],
                    trace_id: vec![0x11; 16],
                    span_id: vec![0x22; 8],
                    flags: 1,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        }],
    };

    sink.export_logs(request).await.unwrap();

    assert_eq!(db.count(schema::LOGS).await, 1);

    let (service, severity, body, queue) = db
        .scalar::<(String, i32, String, String)>(&format!(
            "SELECT ServiceName, SeverityNumber, Body, LogAttributes['queue'] FROM {}",
            schema::LOGS
        ))
        .await;

    assert_eq!(service, "worker");
    assert_eq!(severity, 17);
    assert_eq!(body, "queue drained");
    assert_eq!(queue, "orders");

    db.drop_database().await;
}

#[tokio::test]
async fn writes_each_metric_kind_to_its_own_table() {
    let db = require_clickhouse!("metrics");
    db.drop_database().await;
    let sink = ClickHouseSink::connect(&db.config).await.unwrap();

    let point = |value: f64| NumberDataPoint {
        attributes: vec![string_attr("host", "a")],
        start_time_unix_nano: 1_700_000_000_000_000_000,
        time_unix_nano: 1_700_000_001_000_000_000,
        value: Some(number_data_point::Value::AsDouble(value)),
        ..Default::default()
    };

    let request = ExportMetricsServiceRequest {
        resource_metrics: vec![ResourceMetrics {
            resource: Some(resource("api")),
            scope_metrics: vec![ScopeMetrics {
                scope: Some(scope()),
                metrics: vec![
                    Metric {
                        name: "queue.depth".into(),
                        unit: "{item}".into(),
                        data: Some(Data::Gauge(Gauge {
                            data_points: vec![point(42.0)],
                        })),
                        ..Default::default()
                    },
                    Metric {
                        name: "http.requests".into(),
                        data: Some(Data::Sum(Sum {
                            data_points: vec![point(7.0)],
                            aggregation_temporality: 2,
                            is_monotonic: true,
                        })),
                        ..Default::default()
                    },
                    Metric {
                        name: "http.duration".into(),
                        data: Some(Data::Histogram(Histogram {
                            data_points: vec![HistogramDataPoint {
                                attributes: vec![string_attr("host", "a")],
                                time_unix_nano: 1_700_000_001_000_000_000,
                                count: 3,
                                sum: Some(1.5),
                                bucket_counts: vec![1, 2],
                                explicit_bounds: vec![0.5],
                                min: Some(0.1),
                                max: Some(0.9),
                                ..Default::default()
                            }],
                            aggregation_temporality: 2,
                        })),
                        ..Default::default()
                    },
                    // Unsupported: must be dropped without failing the batch.
                    Metric {
                        name: "legacy.summary".into(),
                        data: Some(Data::Summary(Summary::default())),
                        ..Default::default()
                    },
                ],
                ..Default::default()
            }],
            ..Default::default()
        }],
    };

    sink.export_metrics(request).await.unwrap();

    assert_eq!(db.count(schema::METRICS_GAUGE).await, 1);
    assert_eq!(db.count(schema::METRICS_SUM).await, 1);
    assert_eq!(db.count(schema::METRICS_HISTOGRAM).await, 1);

    let (name, unit, value, host, scope_version) = db
        .scalar::<(String, String, f64, String, String)>(&format!(
            "SELECT MetricName, MetricUnit, Value, Attributes['host'], ScopeVersion FROM {}",
            schema::METRICS_GAUGE
        ))
        .await;
    assert_eq!(name, "queue.depth");
    assert_eq!(unit, "{item}");
    assert_eq!(value, 42.0);
    assert_eq!(host, "a");
    assert_eq!(scope_version, "1.2.3");

    let (monotonic, temporality) = db
        .scalar::<(bool, i32)>(&format!(
            "SELECT IsMonotonic, AggregationTemporality FROM {}",
            schema::METRICS_SUM
        ))
        .await;
    assert!(monotonic);
    assert_eq!(temporality, 2);

    // Array columns need a named row: tuple rows only hold scalar elements.
    #[derive(clickhouse::Row, serde::Deserialize)]
    struct HistogramCheck {
        count: u64,
        sum: f64,
        bucket_counts: Vec<u64>,
        explicit_bounds: Vec<f64>,
        min: f64,
        max: f64,
    }

    let histogram = db
        .client()
        .query(&format!(
            "SELECT Count AS count, Sum AS sum, BucketCounts AS bucket_counts,
                    ExplicitBounds AS explicit_bounds, Min AS min, Max AS max
             FROM {}",
            schema::METRICS_HISTOGRAM
        ))
        .fetch_one::<HistogramCheck>()
        .await
        .unwrap();
    assert_eq!(histogram.count, 3);
    assert_eq!(histogram.sum, 1.5);
    assert_eq!(histogram.bucket_counts, vec![1, 2]);
    assert_eq!(histogram.explicit_bounds, vec![0.5]);
    assert_eq!(histogram.min, 0.1);
    assert_eq!(histogram.max, 0.9);

    db.drop_database().await;
}

#[tokio::test]
async fn an_empty_batch_touches_nothing() {
    let db = require_clickhouse!("empty");
    db.drop_database().await;
    let sink = ClickHouseSink::connect(&db.config).await.unwrap();

    sink.export_traces(ExportTraceServiceRequest::default())
        .await
        .unwrap();
    sink.export_metrics(ExportMetricsServiceRequest::default())
        .await
        .unwrap();
    sink.export_logs(ExportLogsServiceRequest::default())
        .await
        .unwrap();

    assert_eq!(db.count(schema::TRACES).await, 0);
    assert_eq!(db.count(schema::LOGS).await, 0);

    db.drop_database().await;
}

#[tokio::test]
async fn connecting_twice_is_idempotent() {
    let db = require_clickhouse!("idempotent");
    db.drop_database().await;

    ClickHouseSink::connect(&db.config).await.unwrap();
    // `CREATE TABLE IF NOT EXISTS` on an existing schema must not error.
    ClickHouseSink::connect(&db.config).await.unwrap();

    db.drop_database().await;
}
