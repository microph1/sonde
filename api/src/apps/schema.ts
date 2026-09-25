export const APPS_TABLE = 'sonde_apps';
export const KEYS_TABLE = 'sonde_api_keys';

/**
 * Apps and their ingest keys.
 *
 * These are configuration rather than telemetry, and ClickHouse has no UPDATE —
 * so both tables are `ReplacingMergeTree` keyed by id and versioned by
 * `updatedAt`: an edit or a revocation is a new row, and the latest version
 * wins. `FINAL` on the read side is affordable because these tables hold tens
 * of rows, not billions.
 */
export function statements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${APPS_TABLE} (
       id        String,
       name      String,
       createdAt DateTime64(3),
       updatedAt DateTime64(3),
       deleted   UInt8 DEFAULT 0
     )
     ENGINE = ReplacingMergeTree(updatedAt)
     ORDER BY id`,

    `CREATE TABLE IF NOT EXISTS ${KEYS_TABLE} (
       id        String,
       appId     String,
       -- 'secret' for backends, 'public' for browsers. A public key is visible
       -- to anyone who opens devtools, so it is origin-restricted instead of
       -- being treated as a credential.
       kind      LowCardinality(String),
       name      String,
       -- Secret keys are stored as a SHA-256 hash: the database never holds a
       -- usable credential, and a leaked backup is not a set of live keys.
       -- Public keys are stored as-is because they are not secrets.
       secretHash String,
       -- The first characters, kept so the UI can identify a key it can never
       -- show again.
       hint      String,
       origins   Array(String),
       createdAt DateTime64(3),
       updatedAt DateTime64(3),
       revoked   UInt8 DEFAULT 0
     )
     ENGINE = ReplacingMergeTree(updatedAt)
     ORDER BY id`,
  ];
}
