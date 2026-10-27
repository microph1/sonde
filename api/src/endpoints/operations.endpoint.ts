import { Inject } from '@microphi/di';
import { Body, Endpoint, Lambda } from '@microphi/endpoint';

import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { InjectableEndpoint } from '../server/injectable-endpoint';
import { SPAN_WINDOW_SQL, SearchFilters, baseParams } from './filters';
import { configFromEnv } from '../config';

/**
 * Rate, errors and duration, for one service or one operation.
 *
 * `Duration` has been on every span since the first one was ingested and
 * nothing read it: the overview counted spans and the map computed a p95 per
 * edge, so the console could say how much was happening and never how long any
 * of it took. These are the three readings an operator actually asks for, and
 * they are one grouped scan away.
 */
export interface OperationStats {
  readonly ServiceName: string;
  /** Empty when grouping by service — the row is the whole service then. */
  readonly SpanName: string;
  readonly calls: string;
  readonly errors: string;
  /** Milliseconds. Percentiles rather than an average: a mean latency hides
   * exactly the tail you are looking for. */
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  /** Which kinds of span went into the row, so a number that mixes an inbound
   * request with the call it made says so. */
  readonly kinds: string;
}

export interface OperationQuery extends SearchFilters {
  /** `service` for one row per service, `operation` for one per span name. */
  readonly by?: 'service' | 'operation';
  /**
   * Restrict to one kind of span.
   *
   * The honest default is all of them: filtering to Server is the textbook way
   * to read RED, and on a browser-heavy service it would report nothing at all
   * because the browser emits Client and Internal spans. The kinds that went
   * into each row travel back with it instead.
   */
  readonly kind?: string;
  /** `calls`, `errors` or any of the percentiles. */
  readonly sort?: string;
}

const KINDS = ['Server', 'Client', 'Internal', 'Producer', 'Consumer'];
const SORTS: Record<string, string> = {
  calls: 'calls',
  errors: 'errors',
  p50: 'p50Ms',
  p95: 'p95Ms',
  p99: 'p99Ms',
  max: 'maxMs',
};

@Endpoint({
  name: 'operations',
  basePath: '/api',
  cors: true,
})
@InjectableEndpoint()
export class OperationsEndpoint {
  private readonly maxLimit = configFromEnv().maxLimit;

  constructor(@Inject(ClickHouseService) private clickhouse: ClickHouseService) {}

  @Lambda({ method: 'POST', path: '/operations' })
  public async stats(@Body() query: OperationQuery = {}): Promise<OperationStats[]> {
    // Bounded by services × operations rather than by span count, so this is
    // materialised rather than streamed.
    const byOperation = query.by !== 'service';
    const sort = SORTS[query.sort ?? 'calls'] ?? 'calls';
    const kind = KINDS.includes(query.kind ?? '') ? query.kind : '';

    return this.clickhouse.rows<OperationStats>(
      `SELECT ServiceName,
              ${byOperation ? 'SpanName' : "''"} AS SpanName,
              count() AS calls,
              countIf(StatusCode = 'Error') AS errors,
              round(quantile(0.5)(Duration) / 1e6, 2) AS p50Ms,
              round(quantile(0.95)(Duration) / 1e6, 2) AS p95Ms,
              round(quantile(0.99)(Duration) / 1e6, 2) AS p99Ms,
              round(max(Duration) / 1e6, 2) AS maxMs,
              arrayStringConcat(arraySort(groupUniqArray(SpanKind)), ', ') AS kinds
       FROM otel_traces
       WHERE ${SPAN_WINDOW_SQL}
         AND ({kind:String} = '' OR SpanKind = {kind:String})
       GROUP BY ServiceName${byOperation ? ', SpanName' : ''}
       ORDER BY ${sort} DESC
       LIMIT {limit:UInt32}`,
      { ...baseParams(query, this.maxLimit), kind: kind ?? '' },
    );
  }
}
