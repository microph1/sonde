//! Ingest authentication.
//!
//! A key identifies an *app*, which is the grouping dimension the console can
//! trust: `service.name` is whatever the exporter felt like claiming, while the
//! app is decided by which credential was presented.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use clickhouse::Client;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use crate::config::ClickHouseConfig;

/// The resource attribute every authenticated batch is stamped with.
pub const APP_ATTRIBUTE: &str = "sonde.app";

#[derive(Debug, Clone)]
pub struct App {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone)]
struct KeyRecord {
    app: App,
    /// Empty for secret keys; a public key is only accepted from these origins.
    origins: Vec<String>,
    public: bool,
}

#[derive(Debug, Deserialize, clickhouse::Row)]
struct KeyRow {
    #[serde(rename = "secretHash")]
    secret_hash: String,
    #[serde(rename = "appId")]
    app_id: String,
    #[serde(rename = "appName")]
    app_name: String,
    kind: String,
    origins: Vec<String>,
}

/// Why a batch was refused. The distinction matters to the caller: a missing
/// credential is a configuration mistake, a wrong one may be an attack.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejection {
    Missing,
    Unknown,
    /// A public key presented from an origin it was not issued for.
    WrongOrigin,
}

impl Rejection {
    pub fn message(self) -> &'static str {
        match self {
            Self::Missing => "missing ingest credential",
            Self::Unknown => "unrecognised ingest key",
            Self::WrongOrigin => "this key is not allowed from that origin",
        }
    }
}

/// Keys, kept in memory and refreshed on a timer.
///
/// Ingest is the hot path, so it cannot pay for a database round trip per
/// batch. The cost of caching is that a revocation takes up to one refresh
/// interval to bite, which is the trade every gateway makes.
pub struct ApiKeys {
    client: Client,
    keys: RwLock<HashMap<String, KeyRecord>>,
    refresh_interval: Duration,
}

impl ApiKeys {
    pub async fn load(config: &ClickHouseConfig, refresh_seconds: u64) -> anyhow::Result<Arc<Self>> {
        let client = Client::default()
            .with_url(&config.url)
            .with_user(&config.user)
            .with_password(&config.password)
            .with_database(&config.database);

        let keys = Arc::new(Self {
            client,
            keys: RwLock::new(HashMap::new()),
            refresh_interval: Duration::from_secs(refresh_seconds.max(5)),
        });

        // Deliberately not fatal. The API owns the key tables, so on a cold
        // start the receiver can win the race and find nothing there — and a
        // receiver that exits takes ingest down until something restarts it.
        // An empty set rejects everything, which is the safe direction to fail
        // in, and the refresh loop picks the keys up as soon as they exist.
        if let Err(error) = keys.refresh().await {
            tracing::warn!(
                %error,
                "could not load ingest keys yet; refusing all ingest until they appear"
            );
        }

        Ok(keys)
    }

    /// Re-reads the key table until cancelled. A failed refresh keeps the
    /// previous set rather than locking everyone out over a blip.
    pub async fn keep_fresh(self: Arc<Self>, shutdown: CancellationToken) {
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => return,
                _ = tokio::time::sleep(self.refresh_interval) => {
                    if let Err(error) = self.refresh().await {
                        tracing::warn!(%error, "could not refresh ingest keys; keeping the current set");
                    }
                }
            }
        }
    }

    async fn refresh(&self) -> anyhow::Result<()> {
        let rows = self
            .client
            .query(
                "SELECT k.secretHash AS secretHash, k.appId AS appId, a.name AS appName,
                        k.kind AS kind, k.origins AS origins
                 FROM sonde_api_keys AS k FINAL
                 INNER JOIN sonde_apps AS a FINAL ON a.id = k.appId
                 WHERE k.revoked = 0 AND a.deleted = 0",
            )
            .fetch_all::<KeyRow>()
            .await?;

        let loaded = rows
            .into_iter()
            .map(|row| {
                (
                    row.secret_hash,
                    KeyRecord {
                        app: App {
                            id: row.app_id,
                            name: row.app_name,
                        },
                        origins: row.origins,
                        public: row.kind == "public",
                    },
                )
            })
            .collect::<HashMap<_, _>>();

        tracing::debug!(keys = loaded.len(), "ingest keys refreshed");
        *self.keys.write().await = loaded;

        Ok(())
    }

    /// Resolves a presented credential to its app.
    ///
    /// Secret keys are matched by hash, so the cache holds no usable
    /// credential either. Public keys are matched literally — they are not
    /// secrets — and must arrive from an origin they were issued for.
    pub async fn authenticate(
        &self,
        token: Option<&str>,
        origin: Option<&str>,
    ) -> Result<App, Rejection> {
        let Some(token) = token.map(str::trim).filter(|token| !token.is_empty()) else {
            return Err(Rejection::Missing);
        };

        let keys = self.keys.read().await;

        let record = keys
            .get(&hex(Sha256::digest(token.as_bytes()).as_slice()))
            .or_else(|| keys.get(token))
            .ok_or(Rejection::Unknown)?;

        if record.public && !record.origins.is_empty() {
            let allowed = origin.is_some_and(|origin| {
                record.origins.iter().any(|candidate| candidate == origin)
            });

            if !allowed {
                return Err(Rejection::WrongOrigin);
            }
        }

        Ok(record.app.clone())
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Pulls the token out of an `Authorization: Bearer …` value, tolerating a bare
/// key: exporters that only let you set a header value get it wrong often
/// enough that refusing would cost more than it protects.
pub fn bearer(value: &str) -> &str {
    value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
        .unwrap_or(value)
        .trim()
}
