//! Topic naming and the split of an export request into broker messages.

use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;

use crate::storage::clickhouse::value::{attributes, service_name};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    Traces,
    Metrics,
    Logs,
}

impl Signal {
    pub fn topic(self, prefix: &str) -> String {
        format!("{prefix}{}", self.suffix())
    }

    /// Recovers the signal a consumed message belongs to. Matching on the
    /// suffix rather than the full name keeps this working when a deployment
    /// consumes topics written under a different prefix.
    pub fn from_topic(topic: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|signal| topic.ends_with(signal.suffix()))
    }

    fn suffix(self) -> &'static str {
        match self {
            Self::Traces => ".traces",
            Self::Metrics => ".metrics",
            Self::Logs => ".logs",
        }
    }

    pub const ALL: [Signal; 3] = [Signal::Traces, Signal::Metrics, Signal::Logs];
}

/// One broker message: a complete, self-contained export request.
pub struct Message {
    /// Partition key. Keying by service keeps one service's data on one
    /// partition, so a consumer sees its records in produced order.
    pub key: String,
    pub payload: Vec<u8>,
}

/// Splits a batch into one message per resource.
///
/// A whole export request can exceed the broker's 1 MiB default message size,
/// and a resource is the natural unit anyway: it is what carries the service
/// name the messages are keyed by.
pub fn split_traces(request: ExportTraceServiceRequest) -> Vec<Message> {
    request
        .resource_spans
        .into_iter()
        .map(|resource_spans| {
            let key = resource_key(resource_spans.resource.as_ref().map(|r| &r.attributes[..]));
            Message {
                key,
                payload: encode(&ExportTraceServiceRequest {
                    resource_spans: vec![resource_spans],
                }),
            }
        })
        .collect()
}

pub fn split_metrics(request: ExportMetricsServiceRequest) -> Vec<Message> {
    request
        .resource_metrics
        .into_iter()
        .map(|resource_metrics| {
            let key = resource_key(
                resource_metrics
                    .resource
                    .as_ref()
                    .map(|r| &r.attributes[..]),
            );
            Message {
                key,
                payload: encode(&ExportMetricsServiceRequest {
                    resource_metrics: vec![resource_metrics],
                }),
            }
        })
        .collect()
}

pub fn split_logs(request: ExportLogsServiceRequest) -> Vec<Message> {
    request
        .resource_logs
        .into_iter()
        .map(|resource_logs| {
            let key = resource_key(resource_logs.resource.as_ref().map(|r| &r.attributes[..]));
            Message {
                key,
                payload: encode(&ExportLogsServiceRequest {
                    resource_logs: vec![resource_logs],
                }),
            }
        })
        .collect()
}

fn resource_key(
    resource_attributes: Option<&[opentelemetry_proto::tonic::common::v1::KeyValue]>,
) -> String {
    service_name(&attributes(resource_attributes.unwrap_or_default()))
}

fn encode<T: prost::Message>(message: &T) -> Vec<u8> {
    message.encode_to_vec()
}

#[cfg(test)]
mod tests {
    use opentelemetry_proto::tonic::common::v1::{AnyValue, KeyValue, any_value};
    use opentelemetry_proto::tonic::resource::v1::Resource;
    use opentelemetry_proto::tonic::trace::v1::{ResourceSpans, ScopeSpans, Span};
    use prost::Message as _;

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
    fn a_topic_round_trips_through_its_signal() {
        for signal in Signal::ALL {
            assert_eq!(Signal::from_topic(&signal.topic("otel")), Some(signal));
        }
        assert_eq!(Signal::from_topic("otel.profiles"), None);
    }

    #[test]
    fn topics_are_prefixed_per_signal() {
        assert_eq!(Signal::Traces.topic("otel"), "otel.traces");
        assert_eq!(Signal::Metrics.topic("otel"), "otel.metrics");
        assert_eq!(Signal::Logs.topic("otel"), "otel.logs");
    }

    #[test]
    fn one_message_per_resource_keyed_by_service() {
        let request = ExportTraceServiceRequest {
            resource_spans: vec![
                ResourceSpans {
                    resource: Some(resource("api")),
                    scope_spans: vec![ScopeSpans {
                        spans: vec![Span::default()],
                        ..Default::default()
                    }],
                    ..Default::default()
                },
                ResourceSpans {
                    resource: Some(resource("worker")),
                    ..Default::default()
                },
            ],
        };

        let messages = split_traces(request);

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].key, "api");
        assert_eq!(messages[1].key, "worker");

        // Each payload decodes on its own, carrying exactly its resource.
        let decoded = ExportTraceServiceRequest::decode(&messages[0].payload[..]).unwrap();
        assert_eq!(decoded.resource_spans.len(), 1);
        assert_eq!(decoded.resource_spans[0].scope_spans[0].spans.len(), 1);
    }

    #[test]
    fn a_resource_without_a_service_name_still_gets_a_key() {
        let request = ExportTraceServiceRequest {
            resource_spans: vec![ResourceSpans::default()],
        };
        assert_eq!(split_traces(request)[0].key, "unknown_service");
    }

    #[test]
    fn an_empty_batch_produces_nothing() {
        assert!(split_traces(ExportTraceServiceRequest::default()).is_empty());
        assert!(split_logs(ExportLogsServiceRequest::default()).is_empty());
        assert!(split_metrics(ExportMetricsServiceRequest::default()).is_empty());
    }
}
