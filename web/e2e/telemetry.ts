import { APIRequestContext, expect } from '@playwright/test';

const OTLP = process.env['SONDE_E2E_OTLP'] ?? 'http://localhost:4318';
const API = process.env['SONDE_E2E_API'] ?? 'http://localhost:4319';

export function hex(length: number): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

/** A service name nothing else will collide with, so a test can assert on
 * exactly what it sent. */
export function uniqueService(prefix: string): string {
  return `e2e-${prefix}-${Date.now().toString(36)}`;
}

export interface SeededTrace {
  readonly traceId: string;
  readonly rootSpanId: string;
  readonly childSpanId: string;
}

/**
 * Posts a gauge and waits for it to be listed.
 *
 * Metrics have no trace to follow them by, so the wait is on the instrument
 * appearing in the catalogue — which is also the thing the metrics page reads.
 */
export async function seedGauge(
  request: APIRequestContext,
  service: string,
  metric: string,
  value = 42,
): Promise<void> {
  const now = `${Date.now()}000000`;

  const posted = await request.post(`${OTLP}/v1/metrics`, {
    data: {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: service } },
              { key: 'deployment.environment', value: { stringValue: 'e2e' } },
            ],
          },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: metric,
                  unit: 'By',
                  description: 'seeded by the e2e suite',
                  gauge: {
                    dataPoints: [
                      { timeUnixNano: now, startTimeUnixNano: now, asDouble: value },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  });
  expect(posted.ok(), 'the receiver should accept the metric').toBeTruthy();

  await expect
    .poll(
      async () => {
        const response = await request.get(`${API}/api/metrics`);

        expect(response.ok(), 'the read API should answer the seeding poll').toBeTruthy();

        return (await response.text()).includes(metric);
      },
      { message: `metric ${metric} never reached storage`, timeout: 30_000, intervals: [500] },
    )
    .toBe(true);
}

/**
 * Posts a two-span trace and a log record the way any exporter would, then
 * waits for them to come back out of the read API.
 *
 * Seeding through the front door rather than inserting into ClickHouse is
 * deliberate: it exercises the receiver, the broker and the consumer, so a test
 * that passes means the whole path works.
 */
export async function seedTrace(
  request: APIRequestContext,
  service: string,
  options: { status?: 1 | 2; name?: string } = {},
): Promise<SeededTrace> {
  const traceId = hex(32);
  const rootSpanId = hex(16);
  const childSpanId = hex(16);
  const now = `${Date.now()}000000`;
  const status = options.status ?? 1;

  const traces = await request.post(`${OTLP}/v1/traces`, {
    data: {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: service } },
              { key: 'deployment.environment', value: { stringValue: 'e2e' } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId,
                  spanId: rootSpanId,
                  name: options.name ?? 'GET /e2e',
                  kind: 2,
                  startTimeUnixNano: now,
                  endTimeUnixNano: `${Number(now) + 25_000_000}`,
                  status: { code: status },
                },
                {
                  traceId,
                  spanId: childSpanId,
                  parentSpanId: rootSpanId,
                  name: 'db.query',
                  kind: 3,
                  startTimeUnixNano: `${Number(now) + 1_000_000}`,
                  endTimeUnixNano: `${Number(now) + 9_000_000}`,
                  status: { code: 1 },
                },
              ],
            },
          ],
        },
      ],
    },
  });
  expect(traces.ok(), 'the receiver should accept the trace').toBeTruthy();

  const logs = await request.post(`${OTLP}/v1/logs`, {
    data: {
      resourceLogs: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: now,
                  observedTimeUnixNano: now,
                  severityNumber: status === 2 ? 17 : 9,
                  severityText: status === 2 ? 'ERROR' : 'INFO',
                  body: { stringValue: `e2e log for ${service}` },
                  traceId,
                  spanId: rootSpanId,
                },
              ],
            },
          ],
        },
      ],
    },
  });
  expect(logs.ok(), 'the receiver should accept the log').toBeTruthy();

  await waitForTrace(request, traceId);
  // Both signals, not just the span. Spans and log records travel through
  // separate consumers and land at their own pace, and the pages query once on
  // load rather than polling — so a page opened after only the trace had
  // arrived showed "nothing matched" for good, no matter how long the
  // assertion waited. That made every log spec a race it usually won.
  await waitForLog(request, traceId);

  return { traceId, rootSpanId, childSpanId };
}

/** Polls the read API until the span is queryable. */
export async function waitForTrace(request: APIRequestContext, traceId: string): Promise<void> {
  await expect
    .poll(() => rowsReturned(request.get(`${API}/api/traces/${traceId}`)), {
      message: `trace ${traceId} never reached storage`,
      timeout: 30_000,
      intervals: [500],
    })
    .toBeGreaterThan(0);
}

/** The same, for the log record attached to that trace. */
export async function waitForLog(request: APIRequestContext, traceId: string): Promise<void> {
  await expect
    .poll(
      () =>
        rowsReturned(
          request.post(`${API}/api/logs/search`, {
            data: { traceId, from: new Date(Date.now() - 60 * 60_000).toISOString() },
          }),
        ),
      {
        message: `the log for trace ${traceId} never reached storage`,
        timeout: 30_000,
        intervals: [500],
      },
    )
    .toBeGreaterThan(0);
}

/**
 * How many NDJSON rows an answer carries.
 *
 * The status check is what makes this a wait rather than a coin toss: an
 * unauthenticated poll answers `{"error":"not authenticated"}`, which is one
 * non-empty line and so counted as a row — seeding would return immediately and
 * the test would fail somewhere else entirely.
 */
async function rowsReturned(pending: Promise<{ ok(): boolean; text(): Promise<string> }>): Promise<number> {
  const response = await pending;

  expect(response.ok(), 'the read API should answer the seeding poll').toBeTruthy();

  return (await response.text()).split('\n').filter((line) => line.length > 0).length;
}
