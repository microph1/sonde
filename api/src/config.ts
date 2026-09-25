/**
 * Configuration mirrors the receiver's SONDE_CLICKHOUSE_* names so a single
 * .env drives both halves of the stack.
 */
export interface ClickHouseConfig {
  readonly url: string;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

export interface AuthConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  /** Where the browser lands after a completed login or logout. */
  readonly appUrl: string;
  readonly sessionSecret: string;
  readonly sessionHours: number;
  readonly secureCookies: boolean;
  /** Off only for local work without an identity provider. */
  readonly enabled: boolean;
}

export interface ApiConfig {
  readonly port: number;
  readonly corsOrigins: string[];
  readonly clickhouse: ClickHouseConfig;
  /** Upper bound on rows any single query may return. */
  readonly maxLimit: number;
  readonly auth: AuthConfig;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    port: Number(env['SONDE_API_PORT'] ?? 4319),
    corsOrigins: csv(env['SONDE_API_CORS_ORIGINS']),
    clickhouse: {
      url: env['SONDE_CLICKHOUSE_URL'] ?? 'http://localhost:8123',
      database: env['SONDE_CLICKHOUSE_DATABASE'] ?? 'otel',
      user: env['SONDE_CLICKHOUSE_USER'] ?? 'default',
      password: env['SONDE_CLICKHOUSE_PASSWORD'] ?? '',
    },
    maxLimit: Number(env['SONDE_API_MAX_LIMIT'] ?? 10_000),
    auth: {
      issuer: env['SONDE_OIDC_ISSUER'] ?? 'http://localhost:5556/dex',
      clientId: env['SONDE_OIDC_CLIENT_ID'] ?? 'sonde',
      clientSecret: env['SONDE_OIDC_CLIENT_SECRET'] ?? 'dev-client-secret',
      redirectUri:
        env['SONDE_OIDC_REDIRECT_URI'] ?? 'http://localhost:4319/api/auth/callback',
      appUrl: env['SONDE_APP_URL'] ?? 'http://localhost:4200',
      sessionSecret: env['SONDE_SESSION_SECRET'] ?? 'dev-session-secret-change-me',
      sessionHours: Number(env['SONDE_SESSION_HOURS'] ?? 12),
      secureCookies: env['SONDE_SECURE_COOKIES'] === 'true',
      // Opt-out rather than opt-in: an unauthenticated read API should be a
      // deliberate local choice, never something you get by forgetting a
      // variable in production.
      enabled: env['SONDE_AUTH_DISABLED'] !== 'true',
    },
  };
}

function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
