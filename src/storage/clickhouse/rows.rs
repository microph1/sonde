//! Row structs mirroring [`super::schema`], plus the flattening of OTLP's
//! resource → scope → record nesting into one row per record.

use clickhouse::Row;
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::logs::v1::LogRecord;
use opentelemetry_proto::tonic::metrics::v1::{Metric, metric::Data};
use opentelemetry_proto::tonic::trace::v1::span::{Event, Link};
use opentelemetry_proto::tonic::trace::v1::{Span, Status, status::StatusCode};
use serde::Serialize;

use super::value::{Attributes, any_value, attributes, hex_id, nanos, scope_parts, service_name};

#[derive(Debug, Row, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct TraceRow {
    pub timestamp: i64,
    pub trace_id: String,
    pub span_id: String,
    pub parent_span_id: String,
    pub trace_state: String,
    pub span_name: String,
    pub span_kind: String,
    pub service_name: String,
    pub resource_attributes: Attributes,
    pub scope_name: String,
    pub scope_version: String,
    pub span_attributes: Attributes,
    pub duration: u64,
    pub status_code: String,
    pub status_message: String,
    pub events_timestamp: Vec<i64>,
    pub events_name: Vec<String>,
    pub events_attributes: Vec<Attributes>,
    pub links_trace_id: Vec<String>,
    pub links_span_id: Vec<String>,
    pub links_trace_state: Vec<String>,
    pub links_attributes: Vec<Attributes>,
}

#[derive(Debug, Row, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct LogRow {
    pub timestamp: i64,
    pub observed_timestamp: i64,
    pub trace_id: String,
    pub span_id: String,
    pub trace_flags: u32,
    pub severity_text: String,
    pub severity_number: i32,
    pub service_name: String,
    pub body: String,
    pub resource_attributes: Attributes,
    pub scope_name: String,
    pub scope_version: String,
    pub log_attributes: Attributes,
}

/// The three metric tables share a dozen leading columns. Declaring them
/// through a macro keeps the structs and [`super::schema::METRIC_COMMON`] in
/// step; `#[serde(flatten)]` is not an option because RowBinary has no way to
/// encode a nested struct as a flat column list.
macro_rules! metric_row {
    ($name:ident { $($field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Debug, Row, Serialize)]
        #[serde(rename_all = "PascalCase")]
        pub struct $name {
            pub resource_attributes: Attributes,
            pub service_name: String,
            pub scope_name: String,
            pub scope_version: String,
            pub scope_attributes: Attributes,
            pub metric_name: String,
            pub metric_description: String,
            pub metric_unit: String,
            pub attributes: Attributes,
            pub start_timestamp: i64,
            pub timestamp: i64,
            pub flags: u32,
            $(pub $field: $ty,)*
        }
    };
}

/// Builds one of the `metric_row!` structs from a [`MetricCommon`] plus the
/// instrument-specific fields.
macro_rules! metric_row_from {
    ($name:ident, $common:expr, { $($field:ident : $value:expr),* $(,)? }) => {{
        let common = $common;
        $name {
            resource_attributes: common.resource_attributes,
            service_name: common.service_name,
            scope_name: common.scope_name,
            scope_version: common.scope_version,
            scope_attributes: common.scope_attributes,
            metric_name: common.metric_name,
            metric_description: common.metric_description,
            metric_unit: common.metric_unit,
            attributes: common.attributes,
            start_timestamp: common.start_timestamp,
            timestamp: common.timestamp,
            flags: common.flags,
            $($field: $value,)*
        }
    }};
}

metric_row!(GaugeRow { value: f64 });

metric_row!(SumRow {
    value: f64,
    aggregation_temporality: i32,
    is_monotonic: bool,
});

metric_row!(HistogramRow {
    count: u64,
    sum: f64,
    bucket_counts: Vec<u64>,
    explicit_bounds: Vec<f64>,
    min: f64,
    max: f64,
    aggregation_temporality: i32,
});

/// The shared columns, carried between building and row construction. Not a
/// `Row` itself — it never reaches ClickHouse as a value.
#[derive(Debug, Clone)]
pub struct MetricCommon {
    pub resource_attributes: Attributes,
    pub service_name: String,
    pub scope_name: String,
    pub scope_version: String,
    pub scope_attributes: Attributes,
    pub metric_name: String,
    pub metric_description: String,
    pub metric_unit: String,
    pub attributes: Attributes,
    pub start_timestamp: i64,
    pub timestamp: i64,
    pub flags: u32,
}

/// What a batch of metrics decomposes into: one vector per instrument type,
/// since each lands in its own table.
#[derive(Debug, Default)]
pub struct MetricRows {
    pub gauges: Vec<GaugeRow>,
    pub sums: Vec<SumRow>,
    pub histograms: Vec<HistogramRow>,
    /// Instrument types with no table yet — reported rather than dropped quietly.
    pub unsupported: Vec<String>,
}

pub fn trace_rows(request: ExportTraceServiceRequest) -> Vec<TraceRow> {
    let mut rows = Vec::new();

    for resource_spans in request.resource_spans {
        let resource_attributes = resource_spans
            .resource
            .map(|resource| attributes(&resource.attributes))
            .unwrap_or_default();
        let service = service_name(&resource_attributes);

        for scope_spans in resource_spans.scope_spans {
            let (scope_name, scope_version, _) = scope_parts(&scope_spans.scope);

            for span in scope_spans.spans {
                rows.push(trace_row(
                    span,
                    &resource_attributes,
                    &service,
                    &scope_name,
                    &scope_version,
                ));
            }
        }
    }

    rows
}

fn trace_row(
    span: Span,
    resource_attributes: &Attributes,
    service: &str,
    scope_name: &str,
    scope_version: &str,
) -> TraceRow {
    let (events_timestamp, events_name, events_attributes) = split_events(&span.events);
    let (links_trace_id, links_span_id, links_trace_state, links_attributes) =
        split_links(&span.links);
    let status = span.status.unwrap_or_default();

    TraceRow {
        timestamp: nanos(span.start_time_unix_nano),
        trace_id: hex_id(&span.trace_id),
        span_id: hex_id(&span.span_id),
        parent_span_id: hex_id(&span.parent_span_id),
        trace_state: span.trace_state,
        span_name: span.name,
        span_kind: span_kind(span.kind).to_owned(),
        service_name: service.to_owned(),
        resource_attributes: resource_attributes.clone(),
        scope_name: scope_name.to_owned(),
        scope_version: scope_version.to_owned(),
        span_attributes: attributes(&span.attributes),
        duration: span
            .end_time_unix_nano
            .saturating_sub(span.start_time_unix_nano),
        status_code: status_code(&status).to_owned(),
        status_message: status.message,
        events_timestamp,
        events_name,
        events_attributes,
        links_trace_id,
        links_span_id,
        links_trace_state,
        links_attributes,
    }
}

type SplitEvents = (Vec<i64>, Vec<String>, Vec<Attributes>);

fn split_events(events: &[Event]) -> SplitEvents {
    let mut timestamps = Vec::with_capacity(events.len());
    let mut names = Vec::with_capacity(events.len());
    let mut attrs = Vec::with_capacity(events.len());

    for event in events {
        timestamps.push(nanos(event.time_unix_nano));
        names.push(event.name.clone());
        attrs.push(attributes(&event.attributes));
    }

    (timestamps, names, attrs)
}

type SplitLinks = (Vec<String>, Vec<String>, Vec<String>, Vec<Attributes>);

fn split_links(links: &[Link]) -> SplitLinks {
    let mut trace_ids = Vec::with_capacity(links.len());
    let mut span_ids = Vec::with_capacity(links.len());
    let mut trace_states = Vec::with_capacity(links.len());
    let mut attrs = Vec::with_capacity(links.len());

    for link in links {
        trace_ids.push(hex_id(&link.trace_id));
        span_ids.push(hex_id(&link.span_id));
        trace_states.push(link.trace_state.clone());
        attrs.push(attributes(&link.attributes));
    }

    (trace_ids, span_ids, trace_states, attrs)
}

/// The short names the OTel ecosystem queries by, not the wire enum names.
fn span_kind(kind: i32) -> &'static str {
    use opentelemetry_proto::tonic::trace::v1::span::SpanKind;

    match SpanKind::try_from(kind) {
        Ok(SpanKind::Internal) => "Internal",
        Ok(SpanKind::Server) => "Server",
        Ok(SpanKind::Client) => "Client",
        Ok(SpanKind::Producer) => "Producer",
        Ok(SpanKind::Consumer) => "Consumer",
        Ok(SpanKind::Unspecified) | Err(_) => "Unspecified",
    }
}

fn status_code(status: &Status) -> &'static str {
    match StatusCode::try_from(status.code) {
        Ok(StatusCode::Ok) => "Ok",
        Ok(StatusCode::Error) => "Error",
        Ok(StatusCode::Unset) | Err(_) => "Unset",
    }
}

pub fn log_rows(request: ExportLogsServiceRequest) -> Vec<LogRow> {
    let mut rows = Vec::new();

    for resource_logs in request.resource_logs {
        let resource_attributes = resource_logs
            .resource
            .map(|resource| attributes(&resource.attributes))
            .unwrap_or_default();
        let service = service_name(&resource_attributes);

        for scope_logs in resource_logs.scope_logs {
            let (scope_name, scope_version, _) = scope_parts(&scope_logs.scope);

            for record in scope_logs.log_records {
                let timestamp = log_timestamp(&record);
                let body = log_body(&record);

                rows.push(LogRow {
                    timestamp,
                    observed_timestamp: nanos(record.observed_time_unix_nano),
                    trace_id: hex_id(&record.trace_id),
                    span_id: hex_id(&record.span_id),
                    trace_flags: record.flags,
                    severity_text: record.severity_text,
                    severity_number: record.severity_number,
                    service_name: service.clone(),
                    body,
                    resource_attributes: resource_attributes.clone(),
                    scope_name: scope_name.clone(),
                    scope_version: scope_version.clone(),
                    log_attributes: attributes(&record.attributes),
                });
            }
        }
    }

    rows
}

/// When a record happened, falling back to when it was seen.
///
/// `time_unix_nano` is optional in OTLP and the spec says a consumer that finds
/// it unset should use `observed_time_unix_nano`. Rust's
/// `opentelemetry-appender-tracing` sets only the observed time, so storing the
/// field verbatim filed every log from a `tracing`-bridged service at the Unix
/// epoch — which hid them from every time-filtered query, since those all
/// filter on `Timestamp`.
fn log_timestamp(record: &LogRecord) -> i64 {
    if record.time_unix_nano == 0 {
        nanos(record.observed_time_unix_nano)
    } else {
        nanos(record.time_unix_nano)
    }
}

/// The body, or the event name when there is no body.
///
/// A record can carry all its meaning in structured attributes and leave the
/// body empty — the SDKs' own internal logs do exactly that. The attributes are
/// stored either way, but a blank body renders as an empty row, and the event
/// name is the one piece of context that says what the row is.
fn log_body(record: &LogRecord) -> String {
    let body = record.body.as_ref().map(any_value).unwrap_or_default();

    if body.is_empty() {
        record.event_name.clone()
    } else {
        body
    }
}

pub fn metric_rows(request: ExportMetricsServiceRequest) -> MetricRows {
    let mut rows = MetricRows::default();

    for resource_metrics in request.resource_metrics {
        let resource_attributes = resource_metrics
            .resource
            .map(|resource| attributes(&resource.attributes))
            .unwrap_or_default();
        let service = service_name(&resource_attributes);

        for scope_metrics in resource_metrics.scope_metrics {
            let (scope_name, scope_version, scope_attributes) = scope_parts(&scope_metrics.scope);

            for metric in scope_metrics.metrics {
                let base = MetricBase {
                    resource_attributes: &resource_attributes,
                    service: &service,
                    scope_name: &scope_name,
                    scope_version: &scope_version,
                    scope_attributes: &scope_attributes,
                };
                push_metric(&mut rows, metric, &base);
            }
        }
    }

    rows
}

/// Everything a data point inherits from the resource, scope and metric it
/// belongs to, borrowed so it is cloned once per point rather than per lookup.
struct MetricBase<'a> {
    resource_attributes: &'a Attributes,
    service: &'a str,
    scope_name: &'a str,
    scope_version: &'a str,
    scope_attributes: &'a Attributes,
}

impl MetricBase<'_> {
    fn common(
        &self,
        metric: &Metric,
        attrs: Attributes,
        start: u64,
        time: u64,
        flags: u32,
    ) -> MetricCommon {
        MetricCommon {
            resource_attributes: self.resource_attributes.clone(),
            service_name: self.service.to_owned(),
            scope_name: self.scope_name.to_owned(),
            scope_version: self.scope_version.to_owned(),
            scope_attributes: self.scope_attributes.clone(),
            metric_name: metric.name.clone(),
            metric_description: metric.description.clone(),
            metric_unit: metric.unit.clone(),
            attributes: attrs,
            start_timestamp: nanos(start),
            timestamp: nanos(time),
            flags,
        }
    }
}

fn push_metric(rows: &mut MetricRows, metric: Metric, base: &MetricBase<'_>) {
    match &metric.data {
        Some(Data::Gauge(gauge)) => {
            for point in &gauge.data_points {
                let common = base.common(
                    &metric,
                    attributes(&point.attributes),
                    point.start_time_unix_nano,
                    point.time_unix_nano,
                    point.flags,
                );
                rows.gauges.push(metric_row_from!(GaugeRow, common, {
                    value: number_value(point),
                }));
            }
        }
        Some(Data::Sum(sum)) => {
            for point in &sum.data_points {
                let common = base.common(
                    &metric,
                    attributes(&point.attributes),
                    point.start_time_unix_nano,
                    point.time_unix_nano,
                    point.flags,
                );
                rows.sums.push(metric_row_from!(SumRow, common, {
                    value: number_value(point),
                    aggregation_temporality: sum.aggregation_temporality,
                    is_monotonic: sum.is_monotonic,
                }));
            }
        }
        Some(Data::Histogram(histogram)) => {
            for point in &histogram.data_points {
                let common = base.common(
                    &metric,
                    attributes(&point.attributes),
                    point.start_time_unix_nano,
                    point.time_unix_nano,
                    point.flags,
                );
                rows.histograms
                    .push(metric_row_from!(HistogramRow, common, {
                        count: point.count,
                        sum: point.sum.unwrap_or_default(),
                        bucket_counts: point.bucket_counts.clone(),
                        explicit_bounds: point.explicit_bounds.clone(),
                        min: point.min.unwrap_or_default(),
                        max: point.max.unwrap_or_default(),
                        aggregation_temporality: histogram.aggregation_temporality,
                    }));
            }
        }
        Some(Data::ExponentialHistogram(_)) => {
            rows.unsupported
                .push(format!("{}: exponential histogram", metric.name));
        }
        Some(Data::Summary(_)) => rows.unsupported.push(format!("{}: summary", metric.name)),
        None => rows.unsupported.push(format!("{}: no data", metric.name)),
    }
}

/// Integer points are widened to `Float64` so counters and gauges share one
/// column; a monotonic `u64` counter loses precision only past 2^53.
fn number_value(point: &opentelemetry_proto::tonic::metrics::v1::NumberDataPoint) -> f64 {
    use opentelemetry_proto::tonic::metrics::v1::number_data_point::Value;

    match point.value {
        Some(Value::AsDouble(value)) => value,
        Some(Value::AsInt(value)) => value as f64,
        None => 0.0,
    }
}

#[cfg(test)]
mod tests {
    use opentelemetry_proto::tonic::common::v1::{AnyValue, KeyValue, any_value};
    use opentelemetry_proto::tonic::resource::v1::Resource;
    use opentelemetry_proto::tonic::trace::v1::{ResourceSpans, ScopeSpans};

    use super::*;

    fn resource(service: &str) -> Resource {
        Resource {
            attributes: vec![KeyValue {
                key: "service.name".into(),
                value: Some(AnyValue {
                    value: Some(any_value::Value::StringValue(service.into())),
                }),
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[test]
    fn flattens_nesting_and_computes_duration() {
        let request = ExportTraceServiceRequest {
            resource_spans: vec![ResourceSpans {
                resource: Some(resource("api")),
                scope_spans: vec![ScopeSpans {
                    spans: vec![Span {
                        trace_id: vec![0xab; 16],
                        span_id: vec![0xcd; 8],
                        name: "GET /".into(),
                        kind: 2,
                        start_time_unix_nano: 100,
                        end_time_unix_nano: 350,
                        events: vec![Event {
                            time_unix_nano: 120,
                            name: "exception".into(),
                            ..Default::default()
                        }],
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            }],
        };

        let rows = trace_rows(request);

        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.service_name, "api");
        assert_eq!(row.trace_id, "ab".repeat(16));
        assert_eq!(row.span_id, "cd".repeat(8));
        assert_eq!(row.span_kind, "Server");
        assert_eq!(row.status_code, "Unset");
        assert_eq!(row.duration, 250);
        assert_eq!(row.events_name, vec!["exception".to_owned()]);
        assert_eq!(row.events_timestamp, vec![120]);
    }

    #[test]
    fn a_clock_skewed_span_does_not_underflow() {
        let span = Span {
            start_time_unix_nano: 500,
            end_time_unix_nano: 100,
            ..Default::default()
        };
        let row = trace_row(span, &Attributes::new(), "svc", "", "");
        assert_eq!(row.duration, 0);
    }

    #[test]
    fn unsupported_instruments_are_reported() {
        use opentelemetry_proto::tonic::metrics::v1::{ResourceMetrics, ScopeMetrics, Summary};

        let request = ExportMetricsServiceRequest {
            resource_metrics: vec![ResourceMetrics {
                scope_metrics: vec![ScopeMetrics {
                    metrics: vec![Metric {
                        name: "latency".into(),
                        data: Some(Data::Summary(Summary::default())),
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            }],
        };

        let rows = metric_rows(request);

        assert!(rows.gauges.is_empty());
        assert_eq!(rows.unsupported, vec!["latency: summary".to_owned()]);
    }
}
