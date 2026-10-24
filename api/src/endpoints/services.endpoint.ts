import { Endpoint, Lambda, Path } from '@microgamma/apigator';
import { Inject } from '@microphi/di';

import { InjectableEndpoint } from '../server/injectable-endpoint';
import { GROUPINGS, groupingExpression } from './grouping';
import { assertTime } from './filters';

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
  public async list(@Path('app') app?: string): Promise<ServiceSummary[]> {
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
         FROM otel_traces WHERE ({app:String} = '' OR ResourceAttributes['sonde.app'] = {app:String}) GROUP BY ServiceName
         UNION ALL
         SELECT ServiceName, 0 AS traces, count() AS logs, 0 AS metrics, max(Timestamp) AS lastSeen
         FROM otel_logs WHERE ({app:String} = '' OR ResourceAttributes['sonde.app'] = {app:String}) GROUP BY ServiceName
         UNION ALL
         SELECT ServiceName, 0 AS traces, 0 AS logs, count() AS metrics, max(Timestamp) AS lastSeen
         FROM otel_metrics_gauge WHERE ({app:String} = '' OR ResourceAttributes['sonde.app'] = {app:String}) GROUP BY ServiceName
         UNION ALL
         SELECT ServiceName, 0 AS traces, 0 AS logs, count() AS metrics, max(Timestamp) AS lastSeen
         FROM otel_metrics_sum WHERE ({app:String} = '' OR ResourceAttributes['sonde.app'] = {app:String}) GROUP BY ServiceName
         UNION ALL
         SELECT ServiceName, 0 AS traces, 0 AS logs, count() AS metrics, max(Timestamp) AS lastSeen
         FROM otel_metrics_histogram WHERE ({app:String} = '' OR ResourceAttributes['sonde.app'] = {app:String}) GROUP BY ServiceName
       )
       GROUP BY ServiceName
       ORDER BY lastSeen DESC`,
      { app: app ?? '' },
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
    @Path('app') app?: string,
    @Path('from') from?: string,
    @Path('to') to?: string,
  ): Promise<VolumePoint[]> {
    // Two ends rather than a width back from now, when the caller gives them:
    // a window that always ends at `now` cannot be pointed at an incident that
    // has finished, which is most of the incidents worth looking at.
    const to_ = to ?? new Date().toISOString();
    const from_ = from ?? new Date(Date.parse(to_) - 360 * 60_000).toISOString();
    const bounded = Boolean(from && to);
    const window = clamp(Number(windowMinutes ?? 360), 5, 7 * 24 * 60);
    // A day, not an hour. The old ceiling was below the three-hour bucket the
    // seven-day range asks for, so the server quietly answered in hourly
    // buckets while the client filled gaps on a three-hour grid: two thirds of
    // the real buckets missed that grid and were replaced by zeros. The
    // overview read 8 errors where there were 55, and the charts were wrong the
    // same way — silently, because a clamp has no way to say it clamped.
    const bucket = clamp(Number(bucketSeconds ?? 300), 10, 24 * 60 * 60);
    // From an allow-list, never from the request: this one reaches the SQL text
    // rather than travelling as a bound parameter.
    const dimension = groupingExpression(group);
    const windowSql = bounded
      ? `Timestamp >= parseDateTime64BestEffort({from:String}, 9)
           AND Timestamp <= parseDateTime64BestEffort({to:String}, 9)`
      : 'Timestamp >= now() - INTERVAL {window:UInt32} MINUTE';

    return this.clickhouse.rows<VolumePoint>(
      `SELECT toString(bucket) AS bucket, name AS ServiceName,
              sum(spans) AS spans, sum(logs) AS logs, sum(errors) AS errors,
              -- Split as well as summed: "errors" on the overview means both
              -- signals, but anything linking to one of them has to know which
              -- one actually has any, or it sends you to an empty page.
              sum(spanErrors) AS spanErrors, sum(logErrors) AS logErrors
       FROM (
         SELECT toStartOfInterval(Timestamp, INTERVAL {bucket:UInt32} SECOND) AS bucket,
                ${dimension} AS name, count() AS spans, 0 AS logs,
                countIf(StatusCode = 'Error') AS errors,
                countIf(StatusCode = 'Error') AS spanErrors, 0 AS logErrors
         FROM otel_traces
         WHERE ${windowSql}
           AND ({app:String} = '' OR ResourceAttributes['sonde.app'] = {app:String})
         GROUP BY bucket, name
         UNION ALL
         SELECT toStartOfInterval(Timestamp, INTERVAL {bucket:UInt32} SECOND) AS bucket,
                ${dimension} AS name, 0 AS spans, count() AS logs,
                countIf(SeverityNumber >= 17) AS errors,
                0 AS spanErrors, countIf(SeverityNumber >= 17) AS logErrors
         FROM otel_logs
         WHERE ${windowSql}
           AND ({app:String} = '' OR ResourceAttributes['sonde.app'] = {app:String})
         GROUP BY bucket, name
       )
       -- A resource that never set the attribute groups under one honest label
       -- rather than an empty string that reads as a rendering bug.
       WHERE name != ''
       GROUP BY bucket, name
       ORDER BY bucket ASC`,
      { window, bucket, app: app ?? '', from: assertTime(from_, 'from'), to: assertTime(to_, 'to') },
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
