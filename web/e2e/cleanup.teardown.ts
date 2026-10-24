import { test as teardown } from '@playwright/test';

/**
 * Deletes what the suite seeded.
 *
 * Every run invents a dozen service names and posts telemetry under them, and
 * nothing ever removed them: a development stack reached 139 `e2e-*` services,
 * which is not merely untidy — the map draws one node per service, so the real
 * four were a sliver among them and a node became too small to click. Tests
 * that leave the console unusable are not paying for themselves.
 *
 * Through ClickHouse rather than the API, because the read API has no delete
 * and should not grow one for this.
 */
const URL = process.env['SONDE_E2E_CLICKHOUSE_URL'] ?? 'http://localhost:18123';
const USER = process.env['SONDE_E2E_CLICKHOUSE_USER'] ?? 'sonde';
const PASSWORD = process.env['SONDE_E2E_CLICKHOUSE_PASSWORD'] ?? 'sonde';

const TABLES = [
  'otel_traces',
  'otel_logs',
  'otel_metrics_gauge',
  'otel_metrics_sum',
  'otel_metrics_histogram',
];

teardown('remove the seeded services', async () => {
  // Only ever against a database on this machine. The names are matched by a
  // prefix and a prefix is a blunt instrument; a mutation that runs somewhere
  // real because an environment variable pointed there is not a risk worth
  // taking for tidiness.
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(URL)) {
    teardown.skip(true, `refusing to delete from ${URL}: only localhost is cleaned up`);
  }

  for (const table of TABLES) {
    const response = await fetch(URL, {
      method: 'POST',
      headers: {
        'X-ClickHouse-User': USER,
        'X-ClickHouse-Key': PASSWORD,
        'Content-Type': 'text/plain',
      },
      body: `ALTER TABLE otel.${table} DELETE WHERE ServiceName LIKE 'e2e-%'`,
    });

    // Reported rather than thrown: a failed cleanup should not turn a green
    // run red, and the next run will try again.
    if (!response.ok) {
      // eslint-disable-next-line no-console
      console.warn(`could not clean ${table}: ${response.status} ${await response.text()}`);
    }
  }
});
