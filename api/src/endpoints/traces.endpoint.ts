import { Body, Endpoint, Lambda, Path } from '@microgamma/apigator';
import { Inject } from '@microphi/di';

import { InjectableEndpoint } from '../server/injectable-endpoint';

import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { SseResult } from '../clickhouse/sse-result';
import { StreamingResult } from '../clickhouse/streaming-result';
import { tail } from '../clickhouse/tail';
import { configFromEnv } from '../config';
import { SPAN_WINDOW_SQL, SearchFilters, baseParams } from './filters';

export interface TraceFilters extends SearchFilters {
  /** Only spans at least this slow, in milliseconds. */
  readonly minDurationMs?: number;
  /** `Ok`, `Error` or `Unset`; empty matches any. */
  readonly status?: string;
  readonly name?: string;
}

const SPAN_COLUMNS = `
  Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName,
  Duration, StatusCode, StatusMessage, ScopeName, SpanAttributes, ResourceAttributes
`;

@Endpoint({
  name: 'traces',
  basePath: '/api',
  cors: true,
})
@InjectableEndpoint()
export class TracesEndpoint {
  private readonly maxLimit = configFromEnv().maxLimit;

  constructor(@Inject(ClickHouseService) private clickhouse: ClickHouseService) {}

  /**
   * Traces, one row each — not spans.
   *
   * The page is called Traces and listed spans, so the same trace appeared
   * four or five times in a row under four of its own span names, and opening
   * two of them showed the same waterfall twice. A row is a trace now: when it
   * started, what it entered through, how many spans and services it touched,
   * how long the whole thing took.
   *
   * The filters still describe spans, because that is what anyone searching
   * knows — "a trace that touched this service", "a trace with an error". So
   * they select trace ids first and the row is then built from every span of
   * those traces, which is why the subquery is not merely an optimisation: a
   * trace matched by one slow span must still report its full duration and all
   * of its services.
   */
  @Lambda({ method: 'POST', path: '/traces/search' })
  public async search(@Body() filters: TraceFilters = {}): Promise<StreamingResult> {
    const params = {
      ...baseParams(filters, this.maxLimit),
      minDuration: Math.max(0, Math.floor((filters.minDurationMs ?? 0) * 1e6)),
      status: filters.status ?? '',
      name: filters.name ?? '',
    };

    return this.clickhouse.stream(
      `SELECT TraceId,
              -- Not aliased as Timestamp: an alias shadows the column it is
              -- named after for the rest of the SELECT, and the duration below
              -- reads the column.
              toString(min(Timestamp)) AS StartedAt,
              -- The root names the trace. When the root is outside the window
              -- the earliest span stands in, which is honest: it is the oldest
              -- thing known about this trace.
              coalesce(
                nullIf(anyIf(SpanName, ParentSpanId = ''), ''),
                argMin(SpanName, Timestamp)
              ) AS RootName,
              coalesce(
                nullIf(anyIf(ServiceName, ParentSpanId = ''), ''),
                argMin(ServiceName, Timestamp)
              ) AS RootService,
              count() AS Spans,
              uniq(ServiceName) AS Services,
              countIf(StatusCode = 'Error') AS Errors,
              -- Wall time of the whole trace, not of its longest span. Aliased
              -- TotalDuration rather than Duration for the same reason as
              -- above: the window predicate reads the Duration column, and an
              -- alias would hand it this aggregate instead.
              max(toUnixTimestamp64Nano(Timestamp) + Duration)
                - min(toUnixTimestamp64Nano(Timestamp)) AS TotalDuration
       FROM otel_traces
       WHERE ${SPAN_WINDOW_SQL}
         AND TraceId IN (
           SELECT TraceId
           FROM otel_traces
           WHERE ${SPAN_WINDOW_SQL}
             AND Duration >= {minDuration:UInt64}
             AND ({status:String} = '' OR StatusCode = {status:String})
             AND ({name:String} = '' OR SpanName = {name:String})
         )
       GROUP BY TraceId
       ORDER BY StartedAt DESC
       LIMIT {limit:UInt32}`,
      params,
    );
  }

  /**
   * Every span of one trace, oldest first — the order a waterfall renders in,
   * so the client can draw rows as they arrive rather than sorting at the end.
   */
  @Lambda({ method: 'GET', path: '/traces/{traceId}' })
  public async byId(@Path('traceId') traceId: string): Promise<StreamingResult> {
    if (!/^[0-9a-f]{32}$/i.test(traceId)) {
      throw new Error('[400] traceId must be 32 hex characters');
    }

    return this.clickhouse.stream(
      `SELECT ${SPAN_COLUMNS}, EventsTimestamp, EventsName, EventsAttributes
       FROM otel_traces
       WHERE TraceId = {traceId:String}
       ORDER BY Timestamp ASC`,
      { traceId },
    );
  }

  /**
   * Live tail as server-sent events.
   *
   * A GET with filters in the query string because that is all `EventSource`
   * can issue — and `EventSource` is the point: it reconnects on its own when
   * the connection drops, which a tail meant to stay open all day needs and a
   * finite search does not.
   */
  @Lambda({ method: 'GET', path: '/traces/tail' })
  public async tail(
    @Path('service') service?: string,
    @Path('status') status?: string,
  ): Promise<SseResult> {
    const params = {
      service: service ?? '',
      status: status ?? '',
      limit: 500,
    };

    const sql = `SELECT ${SPAN_COLUMNS}
                 FROM otel_traces
                 WHERE Timestamp > parseDateTime64BestEffort({since:String}, 9)
                   AND ({service:String} = '' OR ServiceName = {service:String})
                   AND ({status:String} = '' OR StatusCode = {status:String})
                 ORDER BY Timestamp ASC
                 LIMIT {limit:UInt32}`;

    return new SseResult((signal) =>
      tail<{ Timestamp: string; SpanId: string }>({
        clickhouse: this.clickhouse,
        sql,
        params,
        since: new Date().toISOString(),
        key: (row) => row.SpanId,
        signal,
      }),
    );
  }
}
