import { Body, Endpoint, Lambda } from '@microgamma/apigator';
import { Inject } from '@microphi/di';

import { InjectableEndpoint } from '../server/injectable-endpoint';

import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { StreamingResult } from '../clickhouse/streaming-result';
import { configFromEnv } from '../config';
import { SearchFilters, WINDOW_SQL, baseParams } from './filters';

export interface LogFilters extends SearchFilters {
  /** OTel severity number; 9 is INFO, 17 is ERROR. */
  readonly minSeverity?: number;
  /** Substring match on the log body. */
  readonly contains?: string;
  readonly traceId?: string;
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
    };

    return this.clickhouse.stream(
      `SELECT Timestamp, ServiceName, SeverityText, SeverityNumber, Body,
              TraceId, SpanId, ScopeName, LogAttributes, ResourceAttributes
       FROM otel_logs
       WHERE ${WINDOW_SQL}
         AND SeverityNumber >= {minSeverity:Int32}
         AND ({contains:String} = '' OR positionCaseInsensitive(Body, {contains:String}) > 0)
         AND ({traceId:String} = '' OR TraceId = {traceId:String})
       ORDER BY Timestamp DESC
       LIMIT {limit:UInt32}`,
      params,
    );
  }
}
