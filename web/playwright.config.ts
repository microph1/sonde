import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env['SONDE_E2E_URL'] ?? 'http://localhost:4200';

/**
 * These are system tests, not component tests: they drive the real console
 * against the real API, ClickHouse and Redpanda, and seed their data by posting
 * OTLP to the receiver like any other client would. That is the point — the
 * bugs worth catching here have all been integration bugs.
 *
 * The stack must already be up (`docker compose up -d`) and the API running.
 * The dev server is started by Playwright when it is not already listening.
 */
export default defineConfig({
  testDir: './e2e',
  // Data seeded by one test is visible to every other, and the live-tail specs
  // assert on what is arriving right now — parallel workers would see each
  // other's telemetry.
  workers: 1,
  fullyParallel: false,
  reporter: process.env['CI'] ? 'github' : 'list',
  timeout: 45_000,
  expect: {
    // Ingest is asynchronous: a span posted to the receiver travels through
    // Redpanda and a consumer before ClickHouse can answer for it.
    timeout: 20_000,
  },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /login\.setup\.ts/ },
    {
      name: 'console',
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/session.json' },
    },
    {
      // Deliberately without the stored session, to prove the guard bites.
      name: 'anonymous',
      testMatch: /anonymous\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm start',
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
