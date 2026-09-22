//! Exercises the gRPC receiver over a real socket with a real tonic client.

use std::net::{SocketAddr, TcpListener};
use std::sync::Arc;
use std::time::Duration;

use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::trace_service_client::TraceServiceClient;
use opentelemetry_proto::tonic::trace::v1::{ResourceSpans, ScopeSpans, Span};
use the_watchers::grpc;
use the_watchers::sink::LoggingSink;
use tokio_util::sync::CancellationToken;

/// Asks the OS for a free port and releases it again. The window before the
/// server rebinds is racy in principle; in a test process it is not worth a
/// listener-passing API on `grpc::serve`.
fn free_addr() -> SocketAddr {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
}

#[tokio::test]
async fn exports_spans_over_grpc_and_shuts_down() {
    let addr = free_addr();
    let sink = Arc::new(LoggingSink::default());
    let shutdown = CancellationToken::new();

    let server = tokio::spawn(grpc::serve(addr, sink.clone(), None, shutdown.clone()));

    let mut client = connect(addr).await;
    let response = client
        .export(ExportTraceServiceRequest {
            resource_spans: vec![ResourceSpans {
                scope_spans: vec![ScopeSpans {
                    spans: vec![Span::default(), Span::default()],
                    ..Default::default()
                }],
                ..Default::default()
            }],
        })
        .await
        .expect("export failed");

    assert!(response.into_inner().partial_success.is_none());
    assert_eq!(sink.counts().0, 2);

    shutdown.cancel();
    server
        .await
        .expect("server task panicked")
        .expect("server returned an error");
}

/// The server binds asynchronously, so the first connection can lose the race.
async fn connect(addr: SocketAddr) -> TraceServiceClient<tonic::transport::Channel> {
    let endpoint = format!("http://{addr}");

    for _ in 0..50 {
        if let Ok(client) = TraceServiceClient::connect(endpoint.clone()).await {
            return client;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    panic!("grpc server never accepted a connection on {addr}");
}
