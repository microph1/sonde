import { Body, Endpoint, Lambda, Path } from '@microgamma/apigator';
import { Inject } from '@microphi/di';

import { InjectableEndpoint } from '../server/injectable-endpoint';

import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { SseResult } from '../clickhouse/sse-result';
import { StreamingResult } from '../clickhouse/streaming-result';
import { tail } from '../clickhouse/tail';
import { configFromEnv } from '../config';
import { SearchFilters, WINDOW_SQL, baseParams } from './filters';

export interface LogFilters extends SearchFilters {
  /** OTel severity number; 9 is INFO, 17 is ERROR. */
  readonly minSeverity?: number;
  /** Substring match on the log body. */
  readonly contains?: string;
  readonly traceId?: string;
  /**
   * The instrumentation scope, exactly. For a Rust service that is the module
   * path the record came from — `libp2p_discovery::session` — which makes it
   * the closest thing logs have to a component filter.
   */
  readonly scope?: string;
}

@Endpoint({
  name: 'logs',
  basePath: '/api',
  cors: true,
})
@InjectableEndpoint()
export class LogsEndpoint {
  private readonly maxLimit = configFromEnv().maxLimit;

  constructor(@Inject(ClickHouseService) private clickhouse: ClickHouseService) {}

  @Lambda({ method: 'POST', path: '/logs/search' })
  public async search(@Body() filters: LogFilters = {}): Promise<StreamingResult> {
    const params = {
      ...baseParams(filters, this.maxLimit),
      minSeverity: Math.max(0, Math.floor(filters.minSeverity ?? 0)),
      contains: filters.contains ?? '',
      traceId: filters.traceId ?? '',
      scope: filters.scope ?? '',
    };

    return this.clickhouse.stream(
      `SELECT Timestamp, ServiceName, SeverityText, SeverityNumber, Body,
              TraceId, SpanId, ScopeName, LogAttributes, ResourceAttributes
       FROM otel_logs
       WHERE ${WINDOW_SQL}
         AND SeverityNumber >= {minSeverity:Int32}
         AND ({contains:String} = '' OR positionCaseInsensitive(Body, {contains:String}) > 0)
         AND ({traceId:String} = '' OR TraceId = {traceId:String})
         AND ({scope:String} = '' OR ScopeName = {scope:String})
       ORDER BY Timestamp DESC
       LIMIT {limit:UInt32}`,
      params,
    );
  }

  /**
   * The same search, counted per bucket and severity.
   *
   * The page could show the lines that matched and never the shape of them: a
   * spike at 03:00 was something you found by scrolling, if you found it at
   * all. Bounded by buckets × four levels rather than by row count, so this one
   * is materialised rather than streamed.
   *
   * Every filter from the search applies — a chart of a different set than the
   * table beneath it is worse than no chart.
   */
  @Lambda({ method: 'POST', path: '/logs/histogram' })
  public async histogram(
    @Body() filters: LogFilters & { bucketSeconds?: number } = {},
  ): Promise<SeriesPoint[]> {
    const params = {
      ...baseParams(filters, this.maxLimit),
      minSeverity: Math.max(0, Math.floor(filters.minSeverity ?? 0)),
      contains: filters.contains ?? '',
      traceId: filters.traceId ?? '',
      scope: filters.scope ?? '',
      // A hand-typed bucket could otherwise ask for a million one-second
      // columns across a week.
      bucket: Math.min(Math.max(Math.floor(filters.bucketSeconds ?? 300), 10), 24 * 60 * 60),
    };

    return this.clickhouse.rows<SeriesPoint>(
      `SELECT toString(toStartOfInterval(Timestamp, INTERVAL {bucket:UInt32} SECOND)) AS bucket,
              multiIf(SeverityNumber >= 17, 'error',
                      SeverityNumber >= 13, 'warn',
                      SeverityNumber >= 9, 'info',
                      'debug') AS series,
              count() AS value
       FROM otel_logs
       WHERE ${WINDOW_SQL}
         AND SeverityNumber >= {minSeverity:Int32}
         AND ({contains:String} = '' OR positionCaseInsensitive(Body, {contains:String}) > 0)
         AND ({traceId:String} = '' OR TraceId = {traceId:String})
         AND ({scope:String} = '' OR ScopeName = {scope:String})
       GROUP BY bucket, series
       ORDER BY bucket ASC`,
      params,
    );
  }

  /**
   * Live tail as server-sent events.
   *
   * A GET with filters in the query string because that is all `EventSource`
   * can issue, and `EventSource` is the point: it reconnects on its own when
   * the connection drops, which a tail that is meant to stay open all day needs
   * and a finite search does not.
   */
  @Lambda({ method: 'GET', path: '/logs/tail' })
  public async tail(
    @Path('app') app?: string,
    @Path('service') service?: string,
    @Path('minSeverity') minSeverity?: string,
    @Path('contains') contains?: string,
    @Path('scope') scope?: string,
  ): Promise<SseResult> {
    const params = {
      app: app ?? '',
      service: service ?? '',
      minSeverity: Math.max(0, Math.floor(Number(minSeverity ?? 0)) || 0),
      contains: contains ?? '',
      scope: scope ?? '',
      limit: 500,
    };

    const sql = `SELECT Timestamp, ServiceName, SeverityText, SeverityNumber, Body,
                        TraceId, SpanId, ScopeName, LogAttributes, ResourceAttributes
                 FROM otel_logs
                 WHERE Timestamp > parseDateTime64BestEffort({since:String}, 9)
                   AND ({app:String} = '' OR ResourceAttributes['sonde.app'] = {app:String})
                   AND ({service:String} = '' OR ServiceName = {service:String})
                   AND SeverityNumber >= {minSeverity:Int32}
                   AND ({contains:String} = '' OR positionCaseInsensitive(Body, {contains:String}) > 0)
                   AND ({scope:String} = '' OR ScopeName = {scope:String})
                 ORDER BY Timestamp ASC
                 LIMIT {limit:UInt32}`;

    return new SseResult((signal) =>
      tail<LogRecordRow>({
        clickhouse: this.clickhouse,
        sql,
        params,
        since: new Date().toISOString(),
        // Log records carry no id, so identity is the fields that would have to
        // collide for two records to be genuinely indistinguishable.
        key: (row) => `${row.Timestamp}|${row.ServiceName}|${row.SpanId}|${row.Body}`,
        signal,
      }),
    );
  }
}

interface LogRecordRow {
  readonly Timestamp: string;
  readonly ServiceName: string;
  readonly SpanId: string;
  readonly Body: string;
}

/** One column of the histogram: a bucket, a severity band, and how many. */
export interface SeriesPoint {
  readonly bucket: string;
  readonly series: string;
  readonly value: number;
}
