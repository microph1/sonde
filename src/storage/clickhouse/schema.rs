//! DDL for the receiver's tables.
//!
//! Every table partitions by day and orders by `(ServiceName, …, Timestamp)`,
//! which is the access pattern of every telemetry UI: one service, one time
//! window. Retention is a part-level TTL so expiry is a partition drop rather
//! than a mutation.

pub const TRACES: &str = "otel_traces";
pub const LOGS: &str = "otel_logs";
pub const METRICS_GAUGE: &str = "otel_metrics_gauge";
pub const METRICS_SUM: &str = "otel_metrics_sum";
pub const METRICS_HISTOGRAM: &str = "otel_metrics_histogram";

pub fn statements(ttl_days: u16) -> Vec<String> {
    let ttl = ttl_clause(ttl_days);
    vec![
        traces(&ttl),
        logs(&ttl),
        metrics_gauge(&ttl),
        metrics_sum(&ttl),
        metrics_histogram(&ttl),
    ]
}

/// `ttl_only_drop_parts` keeps expiry to whole-partition drops; without it
/// ClickHouse rewrites parts to remove individual rows.
fn ttl_clause(ttl_days: u16) -> String {
    if ttl_days == 0 {
        String::new()
    } else {
        format!("TTL toDateTime(Timestamp) + toIntervalDay({ttl_days})")
    }
}

fn traces(ttl: &str) -> String {
    format!(
        "CREATE TABLE IF NOT EXISTS {TRACES} (
            Timestamp          DateTime64(9) CODEC(Delta, ZSTD(1)),
            TraceId            String CODEC(ZSTD(1)),
            SpanId             String CODEC(ZSTD(1)),
            ParentSpanId       String CODEC(ZSTD(1)),
            TraceState         String CODEC(ZSTD(1)),
            SpanName           LowCardinality(String) CODEC(ZSTD(1)),
            SpanKind           LowCardinality(String) CODEC(ZSTD(1)),
            ServiceName        LowCardinality(String) CODEC(ZSTD(1)),
            ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
            ScopeName          String CODEC(ZSTD(1)),
            ScopeVersion       String CODEC(ZSTD(1)),
            SpanAttributes     Map(LowCardinality(String), String) CODEC(ZSTD(1)),
            Duration           UInt64 CODEC(ZSTD(1)),
            StatusCode         LowCardinality(String) CODEC(ZSTD(1)),
            StatusMessage      String CODEC(ZSTD(1)),
            EventsTimestamp    Array(DateTime64(9)) CODEC(ZSTD(1)),
            EventsName         Array(LowCardinality(String)) CODEC(ZSTD(1)),
            EventsAttributes   Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
            LinksTraceId       Array(String) CODEC(ZSTD(1)),
            LinksSpanId        Array(String) CODEC(ZSTD(1)),
            LinksTraceState    Array(String) CODEC(ZSTD(1)),
            LinksAttributes    Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
            INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
            INDEX idx_span_attr_key mapKeys(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
            INDEX idx_duration Duration TYPE minmax GRANULARITY 1
        )
        ENGINE = MergeTree
        PARTITION BY toDate(Timestamp)
        ORDER BY (ServiceName, SpanName, toDateTime(Timestamp))
        {ttl}
        SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1"
    )
}

fn logs(ttl: &str) -> String {
    format!(
        "CREATE TABLE IF NOT EXISTS {LOGS} (
            Timestamp          DateTime64(9) CODEC(Delta, ZSTD(1)),
            ObservedTimestamp  DateTime64(9) CODEC(Delta, ZSTD(1)),
            TraceId            String CODEC(ZSTD(1)),
            SpanId             String CODEC(ZSTD(1)),
            TraceFlags         UInt32 CODEC(ZSTD(1)),
            SeverityText       LowCardinality(String) CODEC(ZSTD(1)),
            SeverityNumber     Int32 CODEC(ZSTD(1)),
            ServiceName        LowCardinality(String) CODEC(ZSTD(1)),
            Body               String CODEC(ZSTD(1)),
            ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
            ScopeName          String CODEC(ZSTD(1)),
            ScopeVersion       String CODEC(ZSTD(1)),
            LogAttributes      Map(LowCardinality(String), String) CODEC(ZSTD(1)),
            INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
            INDEX idx_body Body TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 1
        )
        ENGINE = MergeTree
        PARTITION BY toDate(Timestamp)
        ORDER BY (ServiceName, SeverityNumber, toDateTime(Timestamp))
        {ttl}
        SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1"
    )
}

/// Columns every metric point carries, regardless of instrument type.
const METRIC_COMMON: &str = "
            ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
            ServiceName        LowCardinality(String) CODEC(ZSTD(1)),
            ScopeName          String CODEC(ZSTD(1)),
            ScopeVersion       String CODEC(ZSTD(1)),
            ScopeAttributes    Map(LowCardinality(String), String) CODEC(ZSTD(1)),
            MetricName         LowCardinality(String) CODEC(ZSTD(1)),
            MetricDescription  String CODEC(ZSTD(1)),
            MetricUnit         LowCardinality(String) CODEC(ZSTD(1)),
            Attributes         Map(LowCardinality(String), String) CODEC(ZSTD(1)),
            StartTimestamp     DateTime64(9) CODEC(Delta, ZSTD(1)),
            Timestamp          DateTime64(9) CODEC(Delta, ZSTD(1)),
            Flags              UInt32 CODEC(ZSTD(1)),";

const METRIC_ENGINE: &str = "
        ENGINE = MergeTree
        PARTITION BY toDate(Timestamp)
        ORDER BY (ServiceName, MetricName, Attributes, toDateTime(Timestamp))";

fn metrics_gauge(ttl: &str) -> String {
    format!(
        "CREATE TABLE IF NOT EXISTS {METRICS_GAUGE} ({METRIC_COMMON}
            Value Float64 CODEC(ZSTD(1))
        ){METRIC_ENGINE}
        {ttl}
        SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1"
    )
}

fn metrics_sum(ttl: &str) -> String {
    format!(
        "CREATE TABLE IF NOT EXISTS {METRICS_SUM} ({METRIC_COMMON}
            Value                  Float64 CODEC(ZSTD(1)),
            AggregationTemporality Int32 CODEC(ZSTD(1)),
            IsMonotonic            Bool CODEC(ZSTD(1))
        ){METRIC_ENGINE}
        {ttl}
        SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1"
    )
}

fn metrics_histogram(ttl: &str) -> String {
    format!(
        "CREATE TABLE IF NOT EXISTS {METRICS_HISTOGRAM} ({METRIC_COMMON}
            Count                  UInt64 CODEC(ZSTD(1)),
            Sum                    Float64 CODEC(ZSTD(1)),
            BucketCounts           Array(UInt64) CODEC(ZSTD(1)),
            ExplicitBounds         Array(Float64) CODEC(ZSTD(1)),
            Min                    Float64 CODEC(ZSTD(1)),
            Max                    Float64 CODEC(ZSTD(1)),
            AggregationTemporality Int32 CODEC(ZSTD(1))
        ){METRIC_ENGINE}
        {ttl}
        SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_days_means_keep_forever() {
        assert!(!statements(0).iter().any(|sql| sql.contains("TTL")));
        assert!(
            statements(30)
                .iter()
                .all(|sql| sql.contains("toIntervalDay(30)"))
        );
    }

    #[test]
    fn every_table_is_created() {
        assert_eq!(statements(7).len(), 5);
    }
}
