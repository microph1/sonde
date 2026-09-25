//! Stamps an authenticated app onto the resources of a batch.
//!
//! This is the point of the whole key mechanism: `service.name` is whatever the
//! exporter chose to send, but `sonde.app` is decided by which credential
//! was presented, so it is the one attribute the console can group by and
//! trust. Any value the exporter supplied under that key is replaced.

use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::any_value::Value;
use opentelemetry_proto::tonic::common::v1::{AnyValue, KeyValue};
use opentelemetry_proto::tonic::resource::v1::Resource;

use crate::ingest_auth::{APP_ATTRIBUTE, App};

pub fn traces(request: &mut ExportTraceServiceRequest, app: &App) {
    for resource_spans in &mut request.resource_spans {
        stamp(&mut resource_spans.resource, app);
    }
}

pub fn metrics(request: &mut ExportMetricsServiceRequest, app: &App) {
    for resource_metrics in &mut request.resource_metrics {
        stamp(&mut resource_metrics.resource, app);
    }
}

pub fn logs(request: &mut ExportLogsServiceRequest, app: &App) {
    for resource_logs in &mut request.resource_logs {
        stamp(&mut resource_logs.resource, app);
    }
}

fn stamp(resource: &mut Option<Resource>, app: &App) {
    let resource = resource.get_or_insert_with(Resource::default);

    resource
        .attributes
        .retain(|attribute| attribute.key != APP_ATTRIBUTE);

    resource.attributes.push(KeyValue {
        key: APP_ATTRIBUTE.to_owned(),
        value: Some(AnyValue {
            value: Some(Value::StringValue(app.name.clone())),
        }),
        ..Default::default()
    });
}

#[cfg(test)]
mod tests {
    use opentelemetry_proto::tonic::trace::v1::ResourceSpans;

    use super::*;

    fn app() -> App {
        App {
            id: "app-1".into(),
            name: "microgamma".into(),
        }
    }

    fn attribute(request: &ExportTraceServiceRequest) -> Option<String> {
        request.resource_spans[0]
            .resource
            .as_ref()?
            .attributes
            .iter()
            .find(|attribute| attribute.key == APP_ATTRIBUTE)
            .and_then(|attribute| match &attribute.value.as_ref()?.value {
                Some(Value::StringValue(value)) => Some(value.clone()),
                _ => None,
            })
    }

    #[test]
    fn stamps_a_resource_that_had_none() {
        let mut request = ExportTraceServiceRequest {
            resource_spans: vec![ResourceSpans::default()],
        };

        traces(&mut request, &app());

        assert_eq!(attribute(&request).as_deref(), Some("microgamma"));
    }

    /// The whole value of the attribute is that it cannot be self-declared.
    #[test]
    fn overwrites_what_the_exporter_claimed() {
        let mut request = ExportTraceServiceRequest {
            resource_spans: vec![ResourceSpans {
                resource: Some(Resource {
                    attributes: vec![KeyValue {
                        key: APP_ATTRIBUTE.to_owned(),
                        value: Some(AnyValue {
                            value: Some(Value::StringValue("somebody-elses-app".into())),
                        }),
                        ..Default::default()
                    }],
                    ..Default::default()
                }),
                ..Default::default()
            }],
        };

        traces(&mut request, &app());

        assert_eq!(attribute(&request).as_deref(), Some("microgamma"));
        assert_eq!(
            request.resource_spans[0]
                .resource
                .as_ref()
                .unwrap()
                .attributes
                .len(),
            1,
            "the claimed value should be replaced, not accompanied"
        );
    }
}
