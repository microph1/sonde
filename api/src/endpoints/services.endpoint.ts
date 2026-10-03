import { Endpoint, Lambda, Path } from '@microgamma/apigator';
import { Inject } from '@microphi/di';

import { InjectableEndpoint } from '../server/injectable-endpoint';
import { GROUPINGS, groupingExpression } from './grouping';

import { ClickHouseService } from '../clickhouse/clickhouse.service';

export interface ServiceSummary {
  readonly ServiceName: string;
  readonly traces: string;
  readonly logs: string;
  readonly metrics: string;
  readonly lastSeen: string;
}

@Endpoint({
  name: 'services',
  basePath: '/api',
  cors: true,
})
@InjectableEndpoint()
export class ServicesEndpoint {
  constructor(@Inject(ClickHouseService) private clickhouse: ClickHouseService) {}

  /**
   * The navigation root for the UI. Bounded by the number of services rather
   * than the volume of telemetry, so this one is materialised rather than
   * streamed.
   */
  @Lambda({ method: 'GET', path: '/services' })
  public async list(): Promise<ServiceSummary[]> {
    return this.clickhouse.rows<ServiceSummary>(
      // All three signals, because a service that only exports metrics is not a
      // dead service. Counting traces and logs alone had musicbox-streamer
      // reading as last seen hours ago while it was exporting every fifteen
      // seconds, and "services reporting" undercounting to match — the page
      // said nothing was there and was believed twice.
      `SELECT ServiceName,
              sum(traces) AS traces,
              sum(logs) AS logs,
              sum(metrics) AS metrics,
              max(lastSeen) AS lastSeen
       FROM (
         SELECT ServiceName, count() AS traces, 0 AS logs, 0 AS metrics, max(Timestamp) AS lastSeen
         FROM otel_traces GROUP BY ServiceName
         UNION ALL
         SELECT ServiceName, 0 AS traces, count() AS logs, 0 AS metrics, max(Timestamp) AS lastSeen
         FROM otel_logs GROUP BY ServiceName
         UNION ALL
         SELECT ServiceName, 0 AS traces, 0 AS logs, count() AS metrics, max(Timestamp) AS lastSeen
         FROM otel_metrics_gauge GROUP BY ServiceName
         UNION ALL
         SELECT ServiceName, 0 AS traces, 0 AS logs, count() AS metrics, max(Timestamp) AS lastSeen
         FROM otel_metrics_sum GROUP BY ServiceName
         UNION ALL
         SELECT ServiceName, 0 AS traces, 0 AS logs, count() AS metrics, max(Timestamp) AS lastSeen
         FROM otel_metrics_histogram GROUP BY ServiceName
       )
       GROUP BY ServiceName
       ORDER BY lastSeen DESC`,
    );
  }

  /**
   * Telemetry volume per service, bucketed over a window.
   *
   * Bounded by buckets × services rather than by row count — 72 five-minute
   * buckets across a handful of services — so this one is aggregated in
   * ClickHouse and returned whole, rather than streamed.
   */
  @Lambda({ method: 'GET', path: '/services/timeseries' })
  public async timeseries(
    @Path('windowMinutes') windowMinutes?: string,
    @Path('bucketSeconds') bucketSeconds?: string,
    @Path('group') group?: string,
  ): Promise<VolumePoint[]> {
    const window = clamp(Number(windowMinutes ?? 360), 5, 7 * 24 * 60);
    const bucket = clamp(Number(bucketSeconds ?? 300), 10, 3600);
    // From an allow-list, never from the request: this one reaches the SQL text
    // rather than travelling as a bound parameter.
    const dimension = groupingExpression(group);

    return this.clickhouse.rows<VolumePoint>(
      `SELECT toString(bucket) AS bucket, name AS ServiceName,
              sum(spans) AS spans, sum(logs) AS logs, sum(errors) AS errors
       FROM (
         SELECT toStartOfInterval(Timestamp, INTERVAL {bucket:UInt32} SECOND) AS bucket,
                ${dimension} AS name, count() AS spans, 0 AS logs,
                countIf(StatusCode = 'Error') AS errors
         FROM otel_traces
         WHERE Timestamp >= now() - INTERVAL {window:UInt32} MINUTE
         GROUP BY bucket, name
         UNION ALL
         SELECT toStartOfInterval(Timestamp, INTERVAL {bucket:UInt32} SECOND) AS bucket,
                ${dimension} AS name, 0 AS spans, count() AS logs,
                countIf(SeverityNumber >= 17) AS errors
         FROM otel_logs
         WHERE Timestamp >= now() - INTERVAL {window:UInt32} MINUTE
         GROUP BY bucket, name
       )
       -- A resource that never set the attribute groups under one honest label
       -- rather than an empty string that reads as a rendering bug.
       WHERE name != ''
       GROUP BY bucket, name
       ORDER BY bucket ASC`,
      { window, bucket },
    );
  }

  /** The dimensions a caller may group by, for the UI to offer. */
  @Lambda({ method: 'GET', path: '/groupings' })
  public async groupings(): Promise<{ key: string; label: string }[]> {
    return Object.entries(GROUPINGS).map(([key, { label }]) => ({ key, label }));
  }

  @Lambda({ method: 'GET', path: '/health' })
  public async health(): Promise<{ status: string }> {
    await this.clickhouse.rows('SELECT 1 AS ok');
    return { status: 'ok' };
  }
}

export interface VolumePoint {
  readonly bucket: string;
  readonly ServiceName: string;
  readonly spans: number;
  readonly logs: number;
  readonly errors: number;
}

/** Keeps a hand-typed query string from asking for a million one-second buckets. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(Math.floor(value), min), max);
}
