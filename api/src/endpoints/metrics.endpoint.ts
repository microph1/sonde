import { Body, Endpoint, Lambda } from '@microgamma/apigator';
import { Inject } from '@microphi/di';

import { ClickHouseService, QueryParams } from '../clickhouse/clickhouse.service';
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
  /**
   * Resource attributes that name a ceiling, keyed as they arrived —
   * `container.memory.limit` is the cgroup cap the service was started with.
   *
   * A limit belongs on the resource rather than in a series: it is a property
   * of the container, it cannot change without a restart, and as a metric it
   * was a flat line that had to be kept out of every axis it appeared on. It is
   * absent when there is no cap, which is the honest answer — an uncapped
   * cgroup reads `max`, and inventing a ceiling from that would be worse than
   * having none.
   *
   * Values arrive as strings: ResourceAttributes is Map(String, String).
   */
  readonly limits: Record<string, string>;
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
  /** Which percentile to read out of a histogram's buckets. Meaningless for a
   * gauge or a counter, which carry a value rather than a distribution. */
  readonly percentile?: number;
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
  /** Buckets the window held, counting the one a rate spends establishing a
   * baseline. `samples` above zero with no points is a young counter, not a
   * silent one. */
  readonly samples: number;
}

interface OverviewRow extends OverviewPoint {
  readonly name: string;
  readonly kind: MetricKind;
  readonly position: number;
  /** 1 where the first bucket is a baseline rather than a reading. */
  readonly dropFirst: number;
}

/**
 * Resource attributes that name a ceiling rather than a reading.
 *
 * Kept as the map they arrived in instead of being flattened to one number:
 * which ceiling applies to which metric is the caller's question, and a
 * `container.memory.*` card knows to look for `container.memory.limit`.
 */
// `anyIf` rather than `any`: the overview collapses every service reporting a
// metric, and most of them have no cap at all. Picking an arbitrary resource
// would report "no limit" whenever the arbitrary one happened to be uncapped.
const CEILINGS = `
  mapFilter(
    (lk, lv) -> endsWith(lk, '.limit'),
    anyIf(
      ResourceAttributes,
      length(mapFilter((rk, rv) -> endsWith(rk, '.limit'), ResourceAttributes)) > 0
    )
  )
`;

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
/** The scope by itself, for a query with no time window to hang it on. */
const APP_SCOPE = "({app:String} = '' OR ResourceAttributes['sonde.app'] = {app:String})";

const OVERVIEW_WINDOW = `
  ({app:String} = '' OR ResourceAttributes['sonde.app'] = {app:String})
  AND ({service:String} = '' OR ServiceName = {service:String})
  AND Timestamp >= parseDateTime64BestEffort({from:String}, 9)
  AND Timestamp <= parseDateTime64BestEffort({to:String}, 9)
`;

const GAUGE_OVERVIEW_SQL = `
  SELECT name, 'gauge' AS kind, toString(bucket) AS bucket, value, 1 AS position, 0 AS dropFirst
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
  SELECT name, 'sum' AS kind, toString(bucket) AS bucket, value, position, monotonic AS dropFirst
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
  )
  ORDER BY name, bucket
`;

/** A histogram's count is cumulative like a counter's, so the card shows the
 * same thing a counter's does: observations per second. */
const HISTOGRAM_OVERVIEW_SQL = `
  SELECT name, 'histogram' AS kind, toString(bucket) AS bucket, value, position, 1 AS dropFirst
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
    return this.listMetrics('');
  }

  /**
   * The catalogue query, reachable from inside this class.
   *
   * `@Lambda` replaces the method it decorates with a handler that expects an
   * event, so calling `this.catalogue()` from another endpoint reaches the
   * wrapper rather than the query and fails on a body that isn't there.
   */
  private async listMetrics(app: string): Promise<MetricSummary[]> {
    return this.clickhouse.rows<MetricSummary>(
      `SELECT name, kind, unit, description, series, monotonic, limits FROM (
         SELECT MetricName AS name, 'gauge' AS kind, any(MetricUnit) AS unit,
                any(MetricDescription) AS description, uniq(Attributes) AS series,
                0 AS monotonic, ${CEILINGS} AS limits
         FROM ${TABLES.gauge} WHERE ${APP_SCOPE} GROUP BY name
         UNION ALL
         SELECT MetricName AS name, 'sum' AS kind, any(MetricUnit) AS unit,
                any(MetricDescription) AS description, uniq(Attributes) AS series,
                toUInt8(any(IsMonotonic)) AS monotonic, ${CEILINGS} AS limits
         FROM ${TABLES.sum} WHERE ${APP_SCOPE} GROUP BY name
         UNION ALL
         SELECT MetricName AS name, 'histogram' AS kind, any(MetricUnit) AS unit,
                any(MetricDescription) AS description, uniq(Attributes) AS series,
                0 AS monotonic, ${CEILINGS} AS limits
         FROM ${TABLES.histogram} WHERE ${APP_SCOPE} GROUP BY name
       )
       ORDER BY name`,
      { app },
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
      app: query?.app ?? '',
      service: query?.service ?? '',
      from: assertTime(from, 'from'),
      to: assertTime(to, 'to'),
      bucket: Math.min(Math.max(Math.floor(query?.bucketSeconds ?? 900), 60), 86_400),
    };

    const [catalogue, gauges, sums, histograms] = await Promise.all([
      this.listMetrics(params.app),
      this.clickhouse.rows<OverviewRow>(GAUGE_OVERVIEW_SQL, params),
      this.clickhouse.rows<OverviewRow>(SUM_OVERVIEW_SQL, params),
      this.clickhouse.rows<OverviewRow>(HISTOGRAM_OVERVIEW_SQL, params),
    ]);

    const lines = new Map<string, { points: OverviewPoint[]; samples: number }>();

    for (const row of [...gauges, ...sums, ...histograms]) {
      const key = `${row.name}|${row.kind}`;
      const line = lines.get(key) ?? { points: [], samples: 0 };

      // Counted before the first bucket is dropped: a counter deployed twenty
      // minutes ago has one bucket and no rate, and "nothing reported" and
      // "not enough history to subtract yet" are different things to be told.
      line.samples += 1;

      if (!row.dropFirst || row.position > 1) {
        line.points.push({ bucket: row.bucket, value: row.value });
      }

      lines.set(key, line);
    }

    return catalogue.map((metric) => {
      const line = lines.get(`${metric.name}|${metric.kind}`) ?? { points: [], samples: 0 };

      return {
        ...metric,
        points: line.points,
        samples: line.samples,
        latest: line.points.at(-1)?.value ?? null,
      };
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
      app: query.app ?? '',
      service: query.service ?? '',
      from: assertTime(from, 'from'),
      to: assertTime(to, 'to'),
      bucket: Math.min(Math.max(Math.floor(query.bucketSeconds ?? 300), 10), 86_400),
      limit: clampLimit(query.limit, this.maxLimit),
      // Clamped rather than rejected: a percentile outside the range is a
      // caller's slip, and refusing the whole chart over it helps nobody.
      quantile: Math.min(Math.max(query.percentile ?? 0.95, 0.001), 0.999),
    };

    if (kind === 'histogram') {
      return this.distribution(params);
    }

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
        AND ({app:String} = '' OR ResourceAttributes['sonde.app'] = {app:String})
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

  /**
   * A percentile per bucket, read out of the histogram's own buckets.
   *
   * Until now this table was charted by `max(Value)`, a column it does not
   * have — so every histogram answered `Unknown identifier 'Value'` and drew a
   * flat line at zero. They are the latency instruments, which made them the
   * most worth looking at and the only ones you could not.
   *
   * The counts are cumulative since the process started, so the distribution
   * *inside* a bucket is the element-wise difference from the bucket before —
   * the same move the counter rate makes, for the same reason. A restart sends
   * a count backwards; `greatest(0, …)` reads that as a gap rather than as
   * negative traffic.
   *
   * The percentile itself is linear interpolation inside whichever bucket the
   * target count lands in, which is all a bucketed histogram can honestly
   * give: the answer is only ever as precise as the bounds the instrument was
   * configured with.
   */
  private async distribution(params: QueryParams): Promise<SeriesPoint[]> {
    return this.clickhouse.rows<SeriesPoint>(
      `SELECT toString(bucket) AS bucket, series, value FROM (
         SELECT bucket, series,
                -- Where the target count falls, and how far into that bucket.
                arrayCumSum(counts) AS cumulative,
                cumulative[length(cumulative)] AS total,
                total * {quantile:Float64} AS target,
                arrayFirstIndex(x -> x >= target, cumulative) AS at,
                if(at <= 1, 0, cumulative[at - 1]) AS before,
                if(at <= 1, 0, bounds[at - 1]) AS lower,
                -- The last bucket is unbounded above; its own lower bound is
                -- the only honest answer for anything that landed in it.
                if(at > length(bounds), bounds[length(bounds)], bounds[at]) AS upper,
                if(cumulative[at] = before,
                   upper,
                   lower + (upper - lower) * (target - before) / (cumulative[at] - before)) AS raw,
                -- Held to what was actually observed.
                --
                -- Interpolating inside a bucket assumes the observations are
                -- spread across it, and the bounds here jump from 100 ms to
                -- 250: four calls a shade over 100 ms put p95 at 237, a number
                -- no request ever took. The instrument also reports the
                -- largest and smallest it saw, so the estimate can be held
                -- between them. It only ever pulls an over-estimate back
                -- towards something that happened.
                least(greatest(raw, if(minSeen > 0, minSeen, raw)),
                      if(maxSeen > 0, maxSeen, raw)) AS value
         FROM (
           SELECT bucket, series, any(bounds) AS bounds, sumForEach(step) AS counts,
                  max(largest) AS maxSeen, min(smallest) AS minSeen
           FROM (
             SELECT toStartOfInterval(Timestamp, INTERVAL {bucket:UInt32} SECOND) AS bucket,
                    series, bounds, largest, smallest,
                    -- What this export added.
                    --
                    -- A stream whose total went down restarted, and everything
                    -- it reports now is new since that restart. Its first
                    -- export inside the window counts for nothing: the history
                    -- behind it is older than the window, and taking it whole
                    -- would pile every observation the process ever made into
                    -- one bucket.
                    multiIf(
                      position = 1, arrayMap(x -> 0., counts),
                      total >= previousTotal,
                        arrayMap((now, then) -> greatest(0, now - then), counts, previous),
                      counts
                    ) AS step
             FROM (
               SELECT Timestamp,
                      ${SERIES_LABEL} AS series,
                      ExplicitBounds AS bounds,
                      toFloat64(Max) AS largest,
                      toFloat64(Min) AS smallest,
                      arrayMap(x -> toFloat64(x), BucketCounts) AS counts,
                      toFloat64(Count) AS total,
                      lagInFrame(arrayMap(x -> toFloat64(x), BucketCounts)) OVER stream AS previous,
                      lagInFrame(toFloat64(Count)) OVER stream AS previousTotal,
                      row_number() OVER stream AS position
               FROM otel_metrics_histogram
               WHERE MetricName = {name:String}
                 AND ({app:String} = '' OR ResourceAttributes['sonde.app'] = {app:String})
                 AND ({service:String} = '' OR ServiceName = {service:String})
                 AND Timestamp >= parseDateTime64BestEffort({from:String}, 9)
                 AND Timestamp <= parseDateTime64BestEffort({to:String}, 9)
               -- Per emitting process, not per series: two processes reporting
               -- the same attributes are two independent streams, and
               -- differencing across them is arithmetic on unrelated numbers.
               WINDOW stream AS (
                 PARTITION BY ServiceName,
                              ResourceAttributes['service.instance.id'],
                              ${SERIES_LABEL}
                 ORDER BY Timestamp
               )
             )
           )
           GROUP BY bucket, series
         )
         WHERE total > 0
       )
       ORDER BY bucket ASC
       LIMIT {limit:UInt32}`,
      params,
    );
  }
}
