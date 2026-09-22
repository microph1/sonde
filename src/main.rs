use std::sync::Arc;

use anyhow::{Context, bail};
use the_watchers::config::{Backend, Config, IngestAuth};
use the_watchers::ingest_auth::ApiKeys;
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
        let keys = ingest_keys(&config, &shutdown).await?;

        tasks.push(tokio::spawn(grpc::serve(
            config.grpc_addr,
            sink.clone(),
            keys.clone(),
            shutdown.clone(),
        )));
        let cors_origins = config.cors_origins.clone();
        let http_addr = config.http_addr;
        let http_shutdown = shutdown.clone();
        tasks.push(tokio::spawn(async move {
            http::serve(http_addr, sink, keys, &cors_origins, http_shutdown).await
        }));
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

/// Loads the ingest key set, and keeps it fresh, when ingest auth is on.
///
/// `None` means the receiver accepts anything. That is the default so an
/// existing deployment keeps working across an upgrade — but it is said out
/// loud at startup, because an open ingest endpoint should never be a surprise.
async fn ingest_keys(
    config: &Config,
    shutdown: &CancellationToken,
) -> anyhow::Result<Option<Arc<ApiKeys>>> {
    if config.ingest_auth == IngestAuth::Off {
        tracing::warn!("ingest authentication is off: anything that can reach the port can write");
        return Ok(None);
    }

    let keys = ApiKeys::load(&config.clickhouse, config.key_refresh_seconds).await?;
    tokio::spawn(keys.clone().keep_fresh(shutdown.clone()));
    tracing::info!("ingest authentication required");

    Ok(Some(keys))
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
        signal = shutdown_signal() => {
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

/// Resolves on ctrl-c or on `SIGTERM`.
///
/// `SIGTERM` is the one that matters outside a terminal: it is what `docker
/// stop`, a systemd unit and a Kubernetes eviction all send. Listening only for
/// ctrl-c means the graceful path never runs in production — the process is
/// killed once the grace period expires, abandoning whatever was in flight.
async fn shutdown_signal() -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};

        let mut terminate = signal(SignalKind::terminate())?;

        tokio::select! {
            result = tokio::signal::ctrl_c() => result,
            _ = terminate.recv() => Ok(()),
        }
    }

    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await
}

fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "the_watchers=info,warn".into());
    tracing_subscriber::fmt().with_env_filter(filter).init();
}
