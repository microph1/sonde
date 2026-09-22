//! An OTLP receiver: the collector-facing half of OpenTelemetry.
//!
//! Both transports the OTLP spec defines — gRPC on 4317 and HTTP (protobuf or
//! the protobuf JSON mapping) on 4318 — decode into the same generated types
//! and are handed to a single [`sink::Sink`] implementation, which is either
//! the ClickHouse writer or the counting stub.

pub mod config;
pub mod grpc;
pub mod http;
pub mod ingest_auth;
pub mod sink;
pub mod stamp;
pub mod storage;
pub mod stream;
