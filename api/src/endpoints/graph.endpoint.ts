import { Body, Endpoint, Lambda } from '@microgamma/apigator';
import { Inject } from '@microphi/di';

import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { InjectableEndpoint } from '../server/injectable-endpoint';
import { groupingExpression } from './grouping';
import { SearchFilters, assertTime } from './filters';

export interface GraphNode {
  readonly id: string;
  readonly spans: number;
  readonly errors: number;
}

export interface GraphEdge {
  readonly source: string;
  readonly target: string;
  readonly calls: number;
  readonly errors: number;
  readonly p95Ms: number;
  /** CLIENT, SERVER, PRODUCER, CONSUMER — what kind of hop this is. */
  readonly kinds: string;
}

export interface ServiceGraph {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
  /**
   * Spans whose parent is not in the window: either the entry point of a trace
   * or a hop nobody instrumented. Drawn rather than dropped, because a missing
   * parent silently deleting the edge is how an uninstrumented service comes to
   * look like a service with no traffic.
   */
  readonly entries: GraphEdge[];
}

export interface GraphQuery extends SearchFilters {
  readonly group?: string;
}

/**
 * A parent span legitimately starts before its child, so the parent side of the
 * join reaches further back than the window being asked about. Without it, every
 * edge whose parent began just before the window opens disappears.
 */
const PARENT_LOOKBACK_MINUTES = 5;

@Endpoint({
  name: 'graph',
  basePath: '/api',
  cors: true,
})
@InjectableEndpoint()
export class GraphEndpoint {
  constructor(@Inject(ClickHouseService) private clickhouse: ClickHouseService) {}

  /**
   * Who calls whom, from the spans themselves.
   *
   * An edge is a parent/child pair whose two halves fall in different groups.
   * Nothing is needed from the emitters: any propagated context produces the
   * link, whether it travelled over HTTP, a WebRTC data channel or Electron
   * IPC, because all three end up as an ordinary parent span id.
   *
   * Self-edges are kept. Two processes that deliberately share a service name —
   * a renderer and the main process it talks to over IPC — are one node on the
   * map and the hop between them is often the interesting one; filtering
   * `source != target` would delete exactly that. Group by something finer than
   * the service name to pull them apart.
   */
  @Lambda({ method: 'POST', path: '/services/graph' })
  public async graph(@Body() query: GraphQuery = {}): Promise<ServiceGraph> {
    const to = query.to ?? new Date().toISOString();
    const from = query.from ?? new Date(Date.parse(to) - 60 * 60 * 1000).toISOString();
    const group = groupingExpression(query.group);
    const params = {
      from: assertTime(from, 'from'),
      to: assertTime(to, 'to'),
      lookback: PARENT_LOOKBACK_MINUTES,
    };

    const [nodes, edges, entries] = await Promise.all([
      this.clickhouse.rows<GraphNode>(
        `SELECT ${group} AS id,
                count() AS spans,
                countIf(StatusCode = 'Error') AS errors
         FROM otel_traces
         WHERE Timestamp >= parseDateTime64BestEffort({from:String}, 9)
           AND Timestamp <= parseDateTime64BestEffort({to:String}, 9)
           AND ${group} != ''
         GROUP BY id
         ORDER BY spans DESC`,
        params,
      ),
      this.clickhouse.rows<GraphEdge>(
        // Both sides are filtered explicitly: a predicate on the child does not
        // reach the parent table, and an unbounded parent side reads the whole
        // retention window on every call.
        `SELECT parent.group AS source,
                child.group AS target,
                count() AS calls,
                countIf(child.StatusCode = 'Error') AS errors,
                round(quantile(0.95)(child.Duration) / 1e6, 2) AS p95Ms,
                arrayStringConcat(groupUniqArray(child.SpanKind), ', ') AS kinds
         FROM (
           SELECT TraceId, SpanId, ParentSpanId, StatusCode, Duration, SpanKind, ${group} AS group
           FROM otel_traces
           WHERE Timestamp >= parseDateTime64BestEffort({from:String}, 9)
             AND Timestamp <= parseDateTime64BestEffort({to:String}, 9)
             AND ParentSpanId != ''
         ) AS child
         INNER JOIN (
           SELECT TraceId, SpanId, ${group} AS group
           FROM otel_traces
           WHERE Timestamp >= parseDateTime64BestEffort({from:String}, 9) - INTERVAL {lookback:UInt32} MINUTE
             AND Timestamp <= parseDateTime64BestEffort({to:String}, 9)
         ) AS parent
           ON child.TraceId = parent.TraceId AND child.ParentSpanId = parent.SpanId
         WHERE source != '' AND target != ''
         GROUP BY source, target
         ORDER BY calls DESC`,
        params,
      ),
      this.clickhouse.rows<GraphEdge>(
        // A child whose parent is nowhere to be found. Same shape as an edge so
        // the client can draw it the same way, with an empty source.
        `SELECT '' AS source,
                child.group AS target,
                count() AS calls,
                countIf(child.StatusCode = 'Error') AS errors,
                round(quantile(0.95)(child.Duration) / 1e6, 2) AS p95Ms,
                arrayStringConcat(groupUniqArray(child.SpanKind), ', ') AS kinds
         FROM (
           SELECT TraceId, ParentSpanId, StatusCode, Duration, SpanKind, ${group} AS group
           FROM otel_traces
           WHERE Timestamp >= parseDateTime64BestEffort({from:String}, 9)
             AND Timestamp <= parseDateTime64BestEffort({to:String}, 9)
             AND ParentSpanId != ''
         ) AS child
         LEFT JOIN (
           SELECT TraceId, SpanId
           FROM otel_traces
           WHERE Timestamp >= parseDateTime64BestEffort({from:String}, 9) - INTERVAL {lookback:UInt32} MINUTE
             AND Timestamp <= parseDateTime64BestEffort({to:String}, 9)
         ) AS parent
           ON child.TraceId = parent.TraceId AND child.ParentSpanId = parent.SpanId
         WHERE parent.SpanId = '' AND target != ''
         GROUP BY target
         ORDER BY calls DESC`,
        params,
      ),
    ]);

    return { nodes, edges, entries };
  }
}
