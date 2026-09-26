import { Body, Endpoint, Lambda } from '@microgamma/apigator';
import { Inject } from '@microphi/di';

import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { configFromEnv } from '../config';
import { InjectableEndpoint } from '../server/injectable-endpoint';
import { SearchFilters, assertTime, clampLimit } from './filters';

export type MetricKind = 'gauge' | 'sum' | 'histogram';

export interface MetricSummary {
  readonly name: string;
  readonly kind: MetricKind;
  readonly unit: string;
  readonly description: string;
  readonly series: number;
  readonly monotonic: number;
}

export interface SeriesPoint {
  readonly bucket: string;
  readonly series: string;
  readonly value: number;
}

export interface MetricQuery extends SearchFilters {
  readonly name: string;
  readonly kind: MetricKind;
  readonly bucketSeconds?: number;
  /**
   * Turn a cumulative counter into a per-second rate. Meaningless for a gauge,
   * and the only useful reading of a counter — a cumulative series on a fresh
   * process shows "2", which says nothing.
   */
  readonly rate?: boolean;
}

export interface OverviewPoint {
  readonly bucket: string;
  readonly value: number;
}

export interface MetricOverview extends MetricSummary {
  readonly points: OverviewPoint[];
  /** The most recent bucket's reading, or null when nothing landed in the
   * window — which is itself worth saying on a card. */
  readonly latest: number | null;
}

interface OverviewRow extends OverviewPoint {
  readonly name: string;
  readonly kind: MetricKind;
}

const TABLES: Record<MetricKind, string> = {
  gauge: 'otel_metrics_gauge',
  sum: 'otel_metrics_sum',
  histogram: 'otel_metrics_histogram',
};

/**
 * A series is identified by its attribute set. Rendering it as `k=v, k=v` gives
 * the chart a stable label without the client having to know anything about
 * which attributes a given metric happens to carry.
 */
const SERIES_LABEL = `
  arrayStringConcat(
    arrayMap((k, v) -> concat(k, '=', v), mapKeys(Attributes), mapValues(Attributes)),
    ', '
  )
`;

/** Every overview query reads the same window. */
const OVERVIEW_WINDOW = `
  ({service:String} = '' OR ServiceName = {service:String})
  AND Timestamp >= parseDateTime64BestEffort({from:String}, 9)
  AND Timestamp <= parseDateTime64BestEffort({to:String}, 9)
`;

const GAUGE_OVERVIEW_SQL = `
  SELECT name, 'gauge' AS kind, toString(bucket) AS bucket, value
  FROM (
    SELECT MetricName AS name,
           toStartOfInterval(Timestamp, INTERVAL {bucket:UInt32} SECOND) AS bucket,
           avg(Value) AS value
    FROM ${TABLES.gauge}
    WHERE ${OVERVIEW_WINDOW}
    GROUP BY name, bucket
  )
  ORDER BY name, bucket
`;

/**
 * A counter read as a rate, collapsed across its series.
 *
 * Four levels, each doing one thing: take each series' last reading in the
 * bucket, add the series together, step between buckets, then drop the first
 * bucket of a monotonic counter because it has nothing to step from. A
 * non-monotonic sum — an up-down counter — is a level, not a rate, so it
 * passes through as the total.
 */
const SUM_OVERVIEW_SQL = `
  SELECT name, 'sum' AS kind, toString(bucket) AS bucket, value
  FROM (
    SELECT name, bucket, monotonic, position,
           if(monotonic = 1, greatest(0, total - previous) / {bucket:UInt32}, total) AS value
    FROM (
      SELECT name, bucket, total, monotonic,
             lagInFrame(total) OVER (PARTITION BY name ORDER BY bucket) AS previous,
             row_number() OVER (PARTITION BY name ORDER BY bucket) AS position
      FROM (
        SELECT name, bucket, sum(peak) AS total, max(mono) AS monotonic
        FROM (
          SELECT MetricName AS name,
                 toStartOfInterval(Timestamp, INTERVAL {bucket:UInt32} SECOND) AS bucket,
                 Attributes,
                 max(Value) AS peak,
                 max(toUInt8(IsMonotonic)) AS mono
          FROM ${TABLES.sum}
          WHERE ${OVERVIEW_WINDOW}
          GROUP BY name, bucket, Attributes
        )
        GROUP BY name, bucket
      )
    )
    WHERE monotonic = 0 OR position > 1
  )
  ORDER BY name, bucket
`;

/** A histogram's count is cumulative like a counter's, so the card shows the
 * same thing a counter's does: observations per second. */
const HISTOGRAM_OVERVIEW_SQL = `
  SELECT name, 'histogram' AS kind, toString(bucket) AS bucket, value
  FROM (
    SELECT name, bucket, position,
           greatest(0, total - previous) / {bucket:UInt32} AS value
    FROM (
      SELECT name, bucket, total,
             lagInFrame(total) OVER (PARTITION BY name ORDER BY bucket) AS previous,
             row_number() OVER (PARTITION BY name ORDER BY bucket) AS position
      FROM (
        SELECT name, bucket, sum(peak) AS total
        FROM (
          SELECT MetricName AS name,
                 toStartOfInterval(Timestamp, INTERVAL {bucket:UInt32} SECOND) AS bucket,
                 Attributes,
                 max(Count) AS peak
          FROM ${TABLES.histogram}
          WHERE ${OVERVIEW_WINDOW}
          GROUP BY name, bucket, Attributes
        )
        GROUP BY name, bucket
      )
    )
    WHERE position > 1
  )
  ORDER BY name, bucket
`;

@Endpoint({
  name: 'metrics',
  basePath: '/api',
  cors: true,
})
@InjectableEndpoint()
export class MetricsEndpoint {
  private readonly maxLimit = configFromEnv().maxLimit;

  constructor(@Inject(ClickHouseService) private clickhouse: ClickHouseService) {}

  /**
   * Everything that has ever reported, across the three instrument tables.
   *
   * Bounded by the number of distinct metrics rather than by data volume, so it
   * is materialised. `monotonic` travels with it because it is what decides
   * whether a rate is the right reading.
   */
  @Lambda({ method: 'GET', path: '/metrics' })
  public async catalogue(): Promise<MetricSummary[]> {
    return this.listMetrics();
  }

  /**
   * The catalogue query, reachable from inside this class.
   *
   * `@Lambda` replaces the method it decorates with a handler that expects an
   * event, so calling `this.catalogue()` from another endpoint reaches the
   * wrapper rather than the query and fails on a body that isn't there.
   */
  private async listMetrics(): Promise<MetricSummary[]> {
    return this.clickhouse.rows<MetricSummary>(
      `SELECT name, kind, unit, description, series, monotonic FROM (
         SELECT MetricName AS name, 'gauge' AS kind, any(MetricUnit) AS unit,
                any(MetricDescription) AS description, uniq(Attributes) AS series,
                0 AS monotonic
         FROM ${TABLES.gauge} GROUP BY name
         UNION ALL
         SELECT MetricName AS name, 'sum' AS kind, any(MetricUnit) AS unit,
                any(MetricDescription) AS description, uniq(Attributes) AS series,
                toUInt8(any(IsMonotonic)) AS monotonic
         FROM ${TABLES.sum} GROUP BY name
         UNION ALL
         SELECT MetricName AS name, 'histogram' AS kind, any(MetricUnit) AS unit,
                any(MetricDescription) AS description, uniq(Attributes) AS series,
                0 AS monotonic
         FROM ${TABLES.histogram} GROUP BY name
       )
       ORDER BY name`,
    );
  }

  /**
   * The catalogue, with a shape for each entry.
   *
   * A list of metric names tells you what exists; it does not tell you which
   * one is worth opening. One bucketed line each does, and it costs three
   * grouped scans rather than one per card — the page would otherwise fire a
   * request per metric to draw the same thing.
   *
   * Series are collapsed: a card answers "is this moving, and roughly where",
   * and the detail chart underneath breaks it out by attribute set.
   */
  @Lambda({ method: 'POST', path: '/metrics/overview' })
  public async overview(@Body() query: SearchFilters & { bucketSeconds?: number }): Promise<MetricOverview[]> {
    const to = query?.to ?? new Date().toISOString();
    const from = query?.from ?? new Date(Date.parse(to) - 24 * 60 * 60 * 1000).toISOString();
    const params = {
      service: query?.service ?? '',
      from: assertTime(from, 'from'),
      to: assertTime(to, 'to'),
      bucket: Math.min(Math.max(Math.floor(query?.bucketSeconds ?? 900), 60), 86_400),
    };

    const [catalogue, gauges, sums, histograms] = await Promise.all([
      this.listMetrics(),
      this.clickhouse.rows<OverviewRow>(GAUGE_OVERVIEW_SQL, params),
      this.clickhouse.rows<OverviewRow>(SUM_OVERVIEW_SQL, params),
      this.clickhouse.rows<OverviewRow>(HISTOGRAM_OVERVIEW_SQL, params),
    ]);

    const lines = new Map<string, OverviewPoint[]>();

    for (const row of [...gauges, ...sums, ...histograms]) {
      const key = `${row.name}|${row.kind}`;
      const line = lines.get(key) ?? [];

      line.push({ bucket: row.bucket, value: row.value });
      lines.set(key, line);
    }

    return catalogue.map((metric) => {
      const points = lines.get(`${metric.name}|${metric.kind}`) ?? [];

      return { ...metric, points, latest: points.at(-1)?.value ?? null };
    });
  }

  @Lambda({ method: 'POST', path: '/metrics/query' })
  public async query(@Body() query: MetricQuery): Promise<SeriesPoint[]> {
    const kind = query?.kind ?? 'gauge';

    if (!Object.hasOwn(TABLES, kind)) {
      throw new Error('[400] kind must be gauge, sum or histogram');
    }

    if (!query?.name) {
      throw new Error('[400] name is required');
    }

    const to = query.to ?? new Date().toISOString();
    const from = query.from ?? new Date(Date.parse(to) - 6 * 60 * 60 * 1000).toISOString();
    const params = {
      name: query.name,
      service: query.service ?? '',
      from: assertTime(from, 'from'),
      to: assertTime(to, 'to'),
      bucket: Math.min(Math.max(Math.floor(query.bucketSeconds ?? 300), 10), 86_400),
      limit: clampLimit(query.limit, this.maxLimit),
    };

    // A gauge is sampled, so a bucket's value is the average of its samples. A
    // cumulative counter only ever rises, so its bucket value is the last
    // reading — the maximum — and the rate is the step between buckets.
    const aggregate = kind === 'gauge' ? 'avg(Value)' : 'max(Value)';
    const table = TABLES[kind];

    const bucketed = `
      SELECT toStartOfInterval(Timestamp, INTERVAL {bucket:UInt32} SECOND) AS bucket,
             ${SERIES_LABEL} AS series,
             ${aggregate} AS value
      FROM ${table}
      WHERE MetricName = {name:String}
        AND ({service:String} = '' OR ServiceName = {service:String})
        AND Timestamp >= parseDateTime64BestEffort({from:String}, 9)
        AND Timestamp <= parseDateTime64BestEffort({to:String}, 9)
      GROUP BY bucket, series
    `;

    if (kind !== 'sum' || !query.rate) {
      return this.clickhouse.rows<SeriesPoint>(
        `SELECT toString(bucket) AS bucket, series, value
         FROM (${bucketed})
         ORDER BY bucket ASC
         LIMIT {limit:UInt32}`,
        params,
      );
    }

    // `greatest(0, …)` because a counter resets to zero when its process
    // restarts, and a restart should read as a gap rather than as a large
    // negative rate. The first bucket of each series has nothing to subtract
    // from and is dropped for the same reason.
    return this.clickhouse.rows<SeriesPoint>(
      `SELECT toString(bucket) AS bucket, series, value FROM (
         SELECT bucket, series,
                greatest(0, value - previous) / {bucket:UInt32} AS value,
                previous
         FROM (
           SELECT bucket, series, value,
                  lagInFrame(value) OVER (PARTITION BY series ORDER BY bucket) AS previous,
                  row_number() OVER (PARTITION BY series ORDER BY bucket) AS position
           FROM (${bucketed})
         )
         WHERE position > 1
       )
       ORDER BY bucket ASC
       LIMIT {limit:UInt32}`,
      params,
    );
  }
}
