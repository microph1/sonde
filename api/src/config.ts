/**
 * Configuration mirrors the receiver's WATCHERS_CLICKHOUSE_* names so a single
 * .env drives both halves of the stack.
 */
export interface ClickHouseConfig {
  readonly url: string;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

export interface ApiConfig {
  readonly port: number;
  readonly corsOrigins: string[];
  readonly clickhouse: ClickHouseConfig;
  /** Upper bound on rows any single query may return. */
  readonly maxLimit: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    port: Number(env['WATCHERS_API_PORT'] ?? 4319),
    corsOrigins: csv(env['WATCHERS_API_CORS_ORIGINS']),
    clickhouse: {
      url: env['WATCHERS_CLICKHOUSE_URL'] ?? 'http://localhost:8123',
      database: env['WATCHERS_CLICKHOUSE_DATABASE'] ?? 'otel',
      user: env['WATCHERS_CLICKHOUSE_USER'] ?? 'default',
      password: env['WATCHERS_CLICKHOUSE_PASSWORD'] ?? '',
    },
    maxLimit: Number(env['WATCHERS_API_MAX_LIMIT'] ?? 10_000),
  };
}

function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
