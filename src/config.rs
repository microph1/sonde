use std::net::SocketAddr;
use std::str::FromStr;

use anyhow::{Context, bail};

/// OTLP's registered ports; keeping the defaults means any stock exporter
/// talks to us with zero configuration.
pub const DEFAULT_GRPC_ADDR: &str = "0.0.0.0:4317";
pub const DEFAULT_HTTP_ADDR: &str = "0.0.0.0:4318";

#[derive(Debug, Clone)]
pub struct Config {
    pub role: Role,
    pub grpc_addr: SocketAddr,
    pub http_addr: SocketAddr,
    pub backend: Backend,
    /// Origins allowed to export straight from a browser. Empty disables CORS.
    pub cors_origins: Vec<String>,
    pub clickhouse: ClickHouseConfig,
    pub kafka: KafkaConfig,
    pub ingest_auth: IngestAuth,
    /// How often the receiver re-reads the key table.
    pub key_refresh_seconds: u64,
}

/// Which half of the pipeline this process runs. Splitting them is what lets
/// the receivers scale on request rate and the consumers on write throughput.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// Terminate OTLP only.
    Receiver,
    /// Drain the broker into storage only.
    Consumer,
    /// Both in one process; the single-node default.
    All,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    /// Receivers write straight to ClickHouse; no broker involved.
    ClickHouse,
    /// Receivers publish to Redpanda/Kafka and consumers do the writing.
    Kafka,
    /// Accepts and counts without storing. Useful for smoke-testing exporters.
    Log,
}

#[derive(Debug, Clone)]
pub struct KafkaConfig {
    pub brokers: String,
    pub topic_prefix: String,
    pub group_id: String,
    /// How long the producer waits to fill a request before sending it.
    pub linger_ms: u64,
    pub send_timeout_ms: u64,
    pub max_message_bytes: usize,
    /// A consumer flushes once either bound is reached.
    pub batch_messages: usize,
    pub batch_wait_ms: u64,
    pub retry_backoff_ms: u64,
    pub partitions: i32,
    pub replication: i32,
}

#[derive(Debug, Clone)]
pub struct ClickHouseConfig {
    pub url: String,
    pub database: String,
    pub user: String,
    pub password: String,
    /// Days of retention; `0` disables the TTL entirely.
    pub ttl_days: u16,
    pub create_schema: bool,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            role: parse_env("SONDE_ROLE", "all")?,
            grpc_addr: parse_env("SONDE_GRPC_ADDR", DEFAULT_GRPC_ADDR)?,
            http_addr: parse_env("SONDE_HTTP_ADDR", DEFAULT_HTTP_ADDR)?,
            backend: parse_env("SONDE_BACKEND", "clickhouse")?,
            cors_origins: csv_env("SONDE_HTTP_CORS_ORIGINS"),
            clickhouse: ClickHouseConfig::from_env()?,
            kafka: KafkaConfig::from_env()?,
            ingest_auth: parse_env("SONDE_INGEST_AUTH", "off")?,
            key_refresh_seconds: parse_env("SONDE_KEY_REFRESH_SECONDS", "30")?,
        })
    }
}

impl ClickHouseConfig {
    pub fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            url: env("SONDE_CLICKHOUSE_URL", "http://localhost:8123"),
            database: env("SONDE_CLICKHOUSE_DATABASE", "otel"),
            user: env("SONDE_CLICKHOUSE_USER", "default"),
            password: env("SONDE_CLICKHOUSE_PASSWORD", ""),
            ttl_days: parse_env("SONDE_CLICKHOUSE_TTL_DAYS", "30")?,
            create_schema: parse_env("SONDE_CLICKHOUSE_CREATE_SCHEMA", "true")?,
        })
    }
}

impl KafkaConfig {
    pub fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            brokers: env("SONDE_KAFKA_BROKERS", "localhost:9092"),
            topic_prefix: env("SONDE_KAFKA_TOPIC_PREFIX", "otel"),
            group_id: env("SONDE_KAFKA_GROUP_ID", "sonde"),
            linger_ms: parse_env("SONDE_KAFKA_LINGER_MS", "50")?,
            send_timeout_ms: parse_env("SONDE_KAFKA_SEND_TIMEOUT_MS", "10000")?,
            max_message_bytes: parse_env("SONDE_KAFKA_MAX_MESSAGE_BYTES", "16777216")?,
            batch_messages: parse_env("SONDE_KAFKA_BATCH_MESSAGES", "5000")?,
            batch_wait_ms: parse_env("SONDE_KAFKA_BATCH_WAIT_MS", "1000")?,
            retry_backoff_ms: parse_env("SONDE_KAFKA_RETRY_BACKOFF_MS", "2000")?,
            partitions: parse_env("SONDE_KAFKA_PARTITIONS", "3")?,
            replication: parse_env("SONDE_KAFKA_REPLICATION", "1")?,
        })
    }
}

impl Role {
    pub fn runs_receivers(self) -> bool {
        matches!(self, Self::Receiver | Self::All)
    }

    pub fn runs_consumer(self) -> bool {
        matches!(self, Self::Consumer | Self::All)
    }
}

impl FromStr for Role {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> anyhow::Result<Self> {
        match value {
            "receiver" => Ok(Self::Receiver),
            "consumer" => Ok(Self::Consumer),
            "all" => Ok(Self::All),
            other => bail!("expected `receiver`, `consumer` or `all`, got `{other}`"),
        }
    }
}

impl FromStr for Backend {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> anyhow::Result<Self> {
        match value {
            "clickhouse" => Ok(Self::ClickHouse),
            "kafka" => Ok(Self::Kafka),
            "log" => Ok(Self::Log),
            other => bail!("expected `clickhouse`, `kafka` or `log`, got `{other}`"),
        }
    }
}

fn env(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_owned())
}

/// Comma-separated list; blank entries are dropped so a trailing comma or an
/// empty variable both mean "none".
fn csv_env(key: &str) -> Vec<String> {
    env(key, "")
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn parse_env<T>(key: &str, default: &str) -> anyhow::Result<T>
where
    T: FromStr,
    T::Err: std::fmt::Display,
{
    let raw = env(key, default);
    raw.parse()
        .map_err(|e| anyhow::anyhow!("{e}"))
        .with_context(|| format!("{key}: `{raw}` is invalid"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_the_otlp_ports() {
        assert_eq!(
            DEFAULT_GRPC_ADDR.parse::<SocketAddr>().unwrap().port(),
            4317
        );
        assert_eq!(
            DEFAULT_HTTP_ADDR.parse::<SocketAddr>().unwrap().port(),
            4318
        );
    }

    #[test]
    fn rejects_garbage_addresses() {
        unsafe { std::env::set_var("SONDE_TEST_ADDR", "not-an-addr") };
        let error = parse_env::<SocketAddr>("SONDE_TEST_ADDR", DEFAULT_HTTP_ADDR).unwrap_err();
        unsafe { std::env::remove_var("SONDE_TEST_ADDR") };
        assert!(error.to_string().contains("SONDE_TEST_ADDR"));
    }

    #[test]
    fn backend_names_are_exact() {
        assert_eq!(
            "clickhouse".parse::<Backend>().unwrap(),
            Backend::ClickHouse
        );
        assert_eq!("log".parse::<Backend>().unwrap(), Backend::Log);
        assert!("postgres".parse::<Backend>().is_err());
    }
}

/// Ingest authentication. Off by default so an existing deployment keeps
/// working after an upgrade; the receiver says so loudly at startup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IngestAuth {
    Off,
    Required,
}

impl FromStr for IngestAuth {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> anyhow::Result<Self> {
        match value {
            "off" => Ok(Self::Off),
            "required" => Ok(Self::Required),
            other => bail!("expected `off` or `required`, got `{other}`"),
        }
    }
}
