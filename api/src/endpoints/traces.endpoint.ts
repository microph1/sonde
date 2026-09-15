import { Body, Endpoint, Lambda, Path } from '@microgamma/apigator';
import { Inject } from '@microphi/di';

import { InjectableEndpoint } from '../server/injectable-endpoint';

import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { StreamingResult } from '../clickhouse/streaming-result';
import { configFromEnv } from '../config';
import { SearchFilters, WINDOW_SQL, baseParams } from './filters';

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

  @Lambda({ method: 'POST', path: '/traces/search' })
  public async search(@Body() filters: TraceFilters = {}): Promise<StreamingResult> {
    const params = {
      ...baseParams(filters, this.maxLimit),
      minDuration: Math.max(0, Math.floor((filters.minDurationMs ?? 0) * 1e6)),
      status: filters.status ?? '',
      name: filters.name ?? '',
    };

    return this.clickhouse.stream(
      `SELECT ${SPAN_COLUMNS}
       FROM otel_traces
       WHERE ${WINDOW_SQL}
         AND Duration >= {minDuration:UInt64}
         AND ({status:String} = '' OR StatusCode = {status:String})
         AND ({name:String} = '' OR SpanName = {name:String})
       ORDER BY Timestamp DESC
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
}
