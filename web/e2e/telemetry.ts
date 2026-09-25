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

  return { traceId, rootSpanId, childSpanId };
}

/** Polls the read API until the pipeline has caught up. */
export async function waitForTrace(request: APIRequestContext, traceId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await request.get(`${API}/api/traces/${traceId}`);
        const body = await response.text();

        return body.split('\n').filter((line) => line.length > 0).length;
      },
      { message: `trace ${traceId} never reached storage`, timeout: 30_000, intervals: [500] },
    )
    .toBeGreaterThan(0);
}
