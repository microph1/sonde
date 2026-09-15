use std::sync::Arc;

use anyhow::{Context, bail};
use the_watchers::config::{Backend, Config};
use the_watchers::sink::{LoggingSink, Sink};
use the_watchers::storage::clickhouse::ClickHouseSink;
use the_watchers::stream::consumer::Consumer;
use the_watchers::stream::kafka::KafkaSink;
use the_watchers::{grpc, http};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();

    let config = Config::from_env()?;
    let shutdown = CancellationToken::new();
    let mut tasks: Vec<JoinHandle<anyhow::Result<()>>> = Vec::new();

    if config.role.runs_receivers() {
        let sink = receiver_sink(&config).await?;
        tasks.push(tokio::spawn(grpc::serve(
            config.grpc_addr,
            sink.clone(),
            shutdown.clone(),
        )));
        tasks.push(tokio::spawn(http::serve(
            config.http_addr,
            sink,
            shutdown.clone(),
        )));
    }

    if config.role.runs_consumer() {
        if config.backend != Backend::Kafka {
            bail!(
                "WATCHERS_ROLE includes the consumer, but WATCHERS_BACKEND is not `kafka`: \
                 there would be nothing to consume"
            );
        }

        let storage = ClickHouseSink::connect(&config.clickhouse)
            .await
            .context("failed to connect to clickhouse")?;
        let consumer = Consumer::connect(&config.kafka, Arc::new(storage)).await?;
        let shutdown = shutdown.clone();
        tasks.push(tokio::spawn(async move { consumer.run(shutdown).await }));
    }

    run_until_shutdown(tasks, shutdown).await
}

/// Where a receiver puts what it accepts: the broker when there is one, else
/// straight into storage.
async fn receiver_sink(config: &Config) -> anyhow::Result<Arc<dyn Sink>> {
    match config.backend {
        Backend::Kafka => Ok(Arc::new(KafkaSink::connect(&config.kafka).await?)),
        Backend::ClickHouse => {
            let sink = ClickHouseSink::connect(&config.clickhouse)
                .await
                .context("failed to connect to clickhouse")?;
            Ok(Arc::new(sink))
        }
        Backend::Log => {
            tracing::warn!("backend=log: telemetry is counted and discarded, not stored");
            Ok(Arc::new(LoggingSink::default()))
        }
    }
}

/// Waits for ctrl-c, or for any task to finish on its own — which is always a
/// failure here, and takes the rest of the process down with it rather than
/// leaving half a pipeline running.
async fn run_until_shutdown(
    tasks: Vec<JoinHandle<anyhow::Result<()>>>,
    shutdown: CancellationToken,
) -> anyhow::Result<()> {
    if tasks.is_empty() {
        bail!("WATCHERS_ROLE left nothing to run");
    }

    let mut tasks = futures_util::future::select_all(tasks.into_iter().map(Box::pin));

    let result = tokio::select! {
        signal = tokio::signal::ctrl_c() => {
            signal.context("failed to listen for shutdown signal")?;
            tracing::info!("shutting down");
            shutdown.cancel();
            Ok(())
        }
        (result, _, _) = &mut tasks => {
            shutdown.cancel();
            result.context("a task panicked")?
        }
    };

    result
}

fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "the_watchers=info,warn".into());
    tracing_subscriber::fmt().with_env_filter(filter).init();
}
