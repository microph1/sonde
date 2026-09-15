//! Redpanda/Kafka transport between the receiver and storage.
//!
//! The topics carry raw OTLP protobuf rather than flattened rows: replay after
//! a schema change is the main reason the broker is here, and rows that were
//! already flattened under the old schema would defeat it.

pub mod admin;
pub mod consumer;
pub mod kafka;
pub mod topics;
