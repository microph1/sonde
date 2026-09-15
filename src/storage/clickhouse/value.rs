//! OTLP's self-describing value types flattened into what ClickHouse columns
//! can hold: ids become hex, attributes become `Map(String, String)`.

use opentelemetry_proto::tonic::common::v1::any_value::Value;
use opentelemetry_proto::tonic::common::v1::{AnyValue, InstrumentationScope, KeyValue};

/// The value OTel's semantic conventions mandate when a resource declares no
/// `service.name`, so queries never have to special-case an empty string.
pub const UNKNOWN_SERVICE: &str = "unknown_service";

pub type Attributes = Vec<(String, String)>;

pub fn attributes(kvs: &[KeyValue]) -> Attributes {
    kvs.iter()
        .map(|kv| {
            let value = kv.value.as_ref().map(any_value).unwrap_or_default();
            (kv.key.clone(), value)
        })
        .collect()
}

/// Scalars render as their plain text form; arrays and nested key/value lists
/// keep their OTLP JSON shape so nothing is lost, at the cost of needing
/// `JSONExtract` to query.
pub fn any_value(value: &AnyValue) -> String {
    match &value.value {
        Some(Value::StringValue(s)) => s.clone(),
        Some(Value::BoolValue(b)) => b.to_string(),
        Some(Value::IntValue(i)) => i.to_string(),
        Some(Value::DoubleValue(d)) => d.to_string(),
        Some(Value::BytesValue(b)) => hex::encode(b),
        // Introduced for profiles: the value lives in a separate string table
        // that an attribute alone does not carry, so only the index survives.
        Some(Value::StringValueStrindex(index)) => format!("strindex:{index}"),
        Some(Value::ArrayValue(_) | Value::KvlistValue(_)) => {
            serde_json::to_string(value).unwrap_or_default()
        }
        None => String::new(),
    }
}

pub fn service_name(resource_attributes: &[(String, String)]) -> String {
    resource_attributes
        .iter()
        .find(|(key, _)| key == "service.name")
        .map(|(_, value)| value.clone())
        .unwrap_or_else(|| UNKNOWN_SERVICE.to_owned())
}

pub fn scope_parts(scope: &Option<InstrumentationScope>) -> (String, String, Attributes) {
    match scope {
        Some(scope) => (
            scope.name.clone(),
            scope.version.clone(),
            attributes(&scope.attributes),
        ),
        None => (String::new(), String::new(), Attributes::new()),
    }
}

pub fn hex_id(bytes: &[u8]) -> String {
    hex::encode(bytes)
}

/// OTLP carries nanoseconds since the epoch as `u64`; `DateTime64(9)` is signed,
/// and the difference only matters past the year 2262, where both overflow.
pub fn nanos(value: u64) -> i64 {
    value as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kv(key: &str, value: Value) -> KeyValue {
        KeyValue {
            key: key.to_owned(),
            value: Some(AnyValue { value: Some(value) }),
            ..Default::default()
        }
    }

    #[test]
    fn scalars_render_without_quotes() {
        let attrs = attributes(&[
            kv("str", Value::StringValue("a".into())),
            kv("int", Value::IntValue(7)),
            kv("bool", Value::BoolValue(true)),
        ]);

        assert_eq!(
            attrs,
            vec![
                ("str".to_owned(), "a".to_owned()),
                ("int".to_owned(), "7".to_owned()),
                ("bool".to_owned(), "true".to_owned()),
            ]
        );
    }

    #[test]
    fn missing_value_becomes_empty_string() {
        let attrs = attributes(&[KeyValue {
            key: "k".into(),
            value: None,
            ..Default::default()
        }]);
        assert_eq!(attrs, vec![("k".to_owned(), String::new())]);
    }

    #[test]
    fn service_name_falls_back_to_the_semconv_default() {
        assert_eq!(service_name(&[]), UNKNOWN_SERVICE);
        assert_eq!(
            service_name(&[("service.name".to_owned(), "api".to_owned())]),
            "api"
        );
    }
}
