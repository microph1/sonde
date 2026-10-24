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
 * One call from one service to another: a parent span in `from` and its child
 * in `to`, sharing a trace.
 *
 * That pair is the whole of what the map is built from — an edge is a parent
 * and a child that landed in different services — so seeding it is seeding an
 * edge. `seedTrace` cannot: both of its spans carry the same resource.
 */
export async function seedCall(
  request: APIRequestContext,
  from: string,
  to: string,
): Promise<SeededTrace> {
  const traceId = hex(32);
  const rootSpanId = hex(16);
  const childSpanId = hex(16);
  const now = Date.now() * 1_000_000;

  const span = (service: string, id: string, parent: string | undefined, kind: number) => ({
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
            spanId: id,
            ...(parent ? { parentSpanId: parent } : {}),
            name: `${service} work`,
            kind,
            startTimeUnixNano: `${now}`,
            endTimeUnixNano: `${now + 12_000_000}`,
            status: { code: 1 },
          },
        ],
      },
    ],
  });

  const posted = await request.post(`${OTLP}/v1/traces`, {
    data: {
      resourceSpans: [
        span(from, rootSpanId, undefined, 3),
        span(to, childSpanId, rootSpanId, 2),
      ],
    },
  });
  expect(posted.ok(), 'the receiver should accept the call').toBeTruthy();

  await waitForTrace(request, traceId);
  await waitForEdge(request, from, to);

  return { traceId, rootSpanId, childSpanId };
}

/**
 * Polls until the map can see the call.
 *
 * Waiting for the trace is not enough: it returns as soon as one span is
 * queryable, and the edge is a join that needs both halves. The node appeared
 * on the map while the edge it belonged to did not — which looks exactly like
 * a broken query and is really a test that asked too early.
 */
export async function waitForEdge(
  request: APIRequestContext,
  from: string,
  to: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await request.post(`${API}/api/services/graph`, {
          data: { from: new Date(Date.now() - 60 * 60_000).toISOString() },
        });

        expect(response.ok(), 'the read API should answer the seeding poll').toBeTruthy();

        const graph = (await response.json()) as { edges: { source: string; target: string }[] };

        return graph.edges.some((edge) => edge.source === from && edge.target === to);
      },
      { message: `the call ${from} → ${to} never reached the map`, timeout: 30_000, intervals: [500] },
    )
    .toBe(true);
}

/**
 * Posts a histogram as two cumulative exports a minute apart.
 *
 * Two, because the first export of a stream inside a window counts for
 * nothing: its buckets hold everything the process ever observed, which is
 * older than the window. The distribution the console draws is the difference
 * between consecutive exports, so one point is no points.
 */
export async function seedHistogram(
  request: APIRequestContext,
  service: string,
  metric: string,
  bounds: number[] = [10, 100, 1000],
): Promise<void> {
  const minute = 60_000_000_000;
  const now = Date.now() * 1_000_000;
  // One observation to begin with, then two more in the top bucket: the
  // percentile has to land in a bucket that only the difference reveals.
  const exports = [
    { at: now - 2 * minute, counts: ['0', '1', '0', '0'], count: '1', sum: 5, min: 5, max: 5 },
    { at: now - minute, counts: ['0', '1', '0', '2'], count: '3', sum: 2405, min: 5, max: 1200 },
  ];

  const posted = await request.post(`${OTLP}/v1/metrics`, {
    data: {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: service } },
              { key: 'service.instance.id', value: { stringValue: `${service}-1` } },
            ],
          },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: metric,
                  unit: 'ms',
                  description: 'seeded by the e2e suite',
                  histogram: {
                    // 2 is CUMULATIVE, which is what the console has to cope
                    // with and what every instrument here actually sends.
                    aggregationTemporality: 2,
                    dataPoints: exports.map((point) => ({
                      startTimeUnixNano: `${now - 3 * minute}`,
                      timeUnixNano: `${point.at}`,
                      count: point.count,
                      sum: point.sum,
                      min: point.min,
                      max: point.max,
                      bucketCounts: point.counts,
                      explicitBounds: bounds,
                      attributes: [{ key: 'route', value: { stringValue: '/seeded' } }],
                    })),
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  });
  expect(posted.ok(), 'the receiver should accept the histogram').toBeTruthy();

  await expect
    .poll(
      async () => {
        const response = await request.get(`${API}/api/metrics`);

        expect(response.ok(), 'the read API should answer the seeding poll').toBeTruthy();

        return (await response.text()).includes(metric);
      },
      { message: `histogram ${metric} never reached storage`, timeout: 30_000, intervals: [500] },
    )
    .toBe(true);
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
  options: {
    status?: 1 | 2;
    name?: string;
    /** `setStatus`'s message, which is separate from any exception event. */
    statusMessage?: string;
    /** What `recordException` writes: an event named `exception`. */
    exception?: { type: string; message: string; stacktrace?: string };
    /** Put on the root span, as instrumentation would. */
    attributes?: Record<string, string>;
  } = {},
): Promise<SeededTrace> {
  const traceId = hex(32);
  const rootSpanId = hex(16);
  const childSpanId = hex(16);
  const now = `${Date.now()}000000`;
  const status = options.status ?? 1;
  const thrown = options.exception;

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
                  attributes: Object.entries(options.attributes ?? {}).map(([key, value]) => ({
                    key,
                    value: { stringValue: value },
                  })),
                  startTimeUnixNano: now,
                  endTimeUnixNano: `${Number(now) + 25_000_000}`,
                  status: {
                    code: status,
                    ...(options.statusMessage ? { message: options.statusMessage } : {}),
                  },
                  ...(thrown
                    ? {
                        events: [
                          {
                            timeUnixNano: `${Number(now) + 20_000_000}`,
                            name: 'exception',
                            attributes: [
                              { key: 'exception.type', value: { stringValue: thrown.type } },
                              { key: 'exception.message', value: { stringValue: thrown.message } },
                              ...(thrown.stacktrace
                                ? [{
                                    key: 'exception.stacktrace',
                                    value: { stringValue: thrown.stacktrace },
                                  }]
                                : []),
                            ],
                          },
                        ],
                      }
                    : {}),
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
