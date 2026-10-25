import { Injectable, inject } from '@angular/core';
import { Effect, Reduce, Store, makeStore } from '@microphi/store';
import { EMPTY, Observable, combineLatest, from, map, of, skip } from 'rxjs';

import { API_BASE_URL } from './api-base-url';
import { AppScope } from './app-scope';
import { RANGES, Range } from './services.store';
import { bucketOf, resolve, spanMinutes } from './time-range';
import { SeriesPoint } from './telemetry.model';

export type MetricKind = 'gauge' | 'sum' | 'histogram';

export interface MetricSummary {
  readonly name: string;
  readonly kind: MetricKind;
  readonly unit: string;
  readonly description: string;
  readonly series: number;
  /** A counter only rises, so a rate is the only useful reading of it. */
  readonly monotonic: number;
  /**
   * Ceilings carried on the resource, keyed as they arrived:
   * `container.memory.limit` is the cgroup cap the service started with.
   * Absent when there is no cap. Values are strings — resource attributes are
   * a string map — so they are parsed, not cast.
   */
  readonly limits: Record<string, string>;
}

export interface OverviewPoint {
  readonly bucket: string;
  readonly value: number;
}

/** A catalogue entry with enough shape to draw it. */
export interface MetricOverview extends MetricSummary {
  readonly points: OverviewPoint[];
  readonly latest: number | null;
  /** Buckets in the window, counting the one a rate spends on a baseline.
   * Above zero with no points means young, not silent. */
  readonly samples: number;
}

/** What the chart is showing: the metric whose shape leads, and every metric
 * drawn beside it. For a lone metric the two are the same thing. */
export interface Selected {
  readonly lead: MetricOverview;
  readonly members: MetricOverview[];
  readonly labels: Record<string, string>;
}

export interface MetricsState {
  catalogue: MetricOverview[];
  overview: MetricOverview[];
  selected: MetricOverview | null;
  /** The other metrics on the selected card — usage, peak and the process's own
   * resident pages are three readings of one quantity, and a chart of one of
   * them answers a third of the question. */
  members: MetricOverview[];
  labels: Record<string, string>;
  points: SeriesPoint[];
  range: Range;
  rate: boolean;
  /** Which percentile to read from a histogram's buckets. Meaningless for the
   * other kinds, which carry a value rather than a distribution. */
  percentile: number;
  /** The attribute keys a split or a filter can be made of. */
  facets: MetricFacet[];
  /** What the window held, for a histogram; null for the kinds that carry a
   * value rather than a distribution. */
  window: MetricWindowSummary | null;
  /** Which keys make a series. Empty means the whole attribute set. */
  split: string[];
  /** Which values to keep, by key. A key absent from here is unfiltered. */
  where: Record<string, string[]>;
  /** The cap a `.usage` gauge should be read against, when it reports one. */
  reference: number | null;
}

export interface MetricsActions {
  loadCatalogue: () => Observable<MetricOverview[]>;
  loadOverview: (range: Range) => Observable<MetricOverview[]>;
  selectMetric: (members: Member[]) => Observable<Selected>;
  selectRange: (range: Range) => Observable<Range>;
  toggleRate: (rate: boolean) => Observable<boolean>;
  selectPercentile: (percentile: number) => Observable<number>;
  loadFacets: (metric: MetricSummary) => Observable<MetricFacet[]>;
  loadWindow: (query: SeriesQuery) => Observable<MetricWindowSummary | null>;
  selectSplit: (keys: string[]) => Observable<string[]>;
  selectFilter: (filter: Filter) => Observable<Filter>;
  loadSeries: (query: SeriesQuery) => Observable<SeriesPoint[]>;
  loadReference: (metric: MetricSummary) => Observable<number | null>;
}

/** The values kept for one attribute key. */
export interface Filter {
  readonly key: string;
  readonly values: string[];
}

/** The attribute keys a metric carries, and the values each has taken. */
/** What a window held, from the numbers a histogram reports outright. */
export interface MetricWindowSummary {
  /** Which services reported it, so a reader can be sent to their traces. */
  readonly services: string[];
  readonly observations: number;
  readonly mean: number;
  readonly smallest: number;
  readonly largest: number;
}

export interface MetricFacet {
  readonly key: string;
  readonly values: string[];
}

/** One line to draw, and what to call it. */
export interface Member {
  readonly key: string;
  readonly label: string;
}

export interface SeriesQuery {
  readonly members: MetricOverview[];
  readonly labels: Record<string, string>;
  readonly range: Range;
  readonly rate: boolean;
  readonly percentile: number;
  readonly split: string[];
  readonly where: Record<string, string[]>;
}

/** Everything before the last segment: `container.memory.usage` scopes to
 * `container.memory`, which is where its ceiling is named. */
function scopeOf(name: string): string {
  const cut = name.lastIndexOf('.');

  return cut > 0 ? name.slice(0, cut) : name;
}

@Injectable({ providedIn: 'root' })
export class MetricsStore
  extends Store<MetricsState, MetricsActions>
  implements makeStore<MetricsState, MetricsActions>
{
  private readonly baseUrl = inject(API_BASE_URL);
  /** Every query is of one app's telemetry; the scope says which. */
  private readonly scope = inject(AppScope);

  readonly catalogue$ = this.select((state) => state.catalogue);
  readonly overview$ = this.select((state) => state.overview);
  readonly selected$ = this.select((state) => state.selected);
  readonly members$ = this.select((state) => state.members);
  readonly labels$ = this.select((state) => state.labels);
  readonly points$ = this.select((state) => state.points);
  readonly range$ = this.select((state) => state.range);
  readonly rate$ = this.select((state) => state.rate);
  readonly percentile$ = this.select((state) => state.percentile);
  readonly facets$ = this.select((state) => state.facets);
  readonly window$ = this.select((state) => state.window);
  readonly split$ = this.select((state) => state.split);
  readonly where$ = this.select((state) => state.where);
  readonly reference$ = this.select((state) => state.reference);

  constructor() {
    super({
      catalogue: [],
      overview: [],
      selected: null,
      members: [],
      labels: {},
      points: [],
      // Metrics are sampled minutes apart, so the overview's one-hour default
      // would show a handful of points; a day is the smallest window with shape.
      range: RANGES[2],
      rate: false,
      percentile: 0.95,
      facets: [],
      window: null,
      split: [],
      where: {},
      reference: null,
    });

    // The series follows all three, so the store owns the link rather than
    // asking the view to remember which of them require a reload.
    combineLatest([
      this.selected$,
      this.members$,
      this.labels$,
      this.range$,
      this.rate$,
      this.percentile$,
      this.split$,
      this.where$,
    ]).subscribe(
      ([metric, members, labels, range, rate, percentile, split, where]) => {
        if (metric) {
          this.dispatch('loadSeries', {
            members: members.length ? members : [metric],
            labels,
            range,
            rate,
            percentile,
            split,
            where,
          });
          this.dispatch('loadWindow', {
            members: members.length ? members : [metric],
            labels,
            range,
            rate,
            percentile,
            split,
            where,
          });
          this.dispatch('loadReference', metric);
          // The keys a split or a filter can be made of come from the metric
          // and the window, so they are reloaded with either.
          this.dispatch('loadFacets', metric);
        }
      },
    );

    // Every card is drawn over the same window as the chart above it, so the
    // overview follows the range for the same reason the series does. `skip(1)`
    // because the view asks for the first load itself — subscribing here fires
    // immediately, and two requests would race to fill the same list.
    this.range$.pipe(skip(1)).subscribe((range) => this.dispatch('loadOverview', range));
  }

  /**
   * The catalogue, each entry carrying its own line.
   *
   * One request for the whole page. The alternative was a request per card,
   * which on a page listing thirty metrics is thirty round trips to draw
   * thirty small things.
   */
  @Effect()
  loadCatalogue(): Observable<MetricOverview[]> {
    return this.fetchOverview(this.snapshot().range);
  }

  @Reduce()
  onLoadCatalogue(state: MetricsState, overview: MetricOverview[]): MetricsState {
    return this.withOverview(state, overview);
  }

  @Effect()
  loadOverview(range: Range): Observable<MetricOverview[]> {
    return this.fetchOverview(range);
  }

  @Reduce()
  onLoadOverview(state: MetricsState, overview: MetricOverview[]): MetricsState {
    return this.withOverview(state, overview);
  }

  /**
   * Takes `name|kind` keys rather than objects, so the view dispatches what it
   * already has on screen without resolving anything itself.
   *
   * More than one because a card can be a family: usage, peak and the
   * process's own resident pages are three readings of one quantity, and the
   * chart should draw all of them. The first leads — it is the one the
   * description, the unit and the rate toggle speak for.
   */
  @Effect()
  selectMetric(members: Member[]): Observable<Selected> {
    const catalogue = this.snapshot().catalogue;
    const resolved = members
      .map((member) => {
        const [name, kind] = member.key.split('|');

        return catalogue.find((metric) => metric.name === name && metric.kind === kind);
      })
      .filter((metric): metric is MetricOverview => Boolean(metric));

    if (resolved.length === 0) {
      return EMPTY;
    }

    const labels: Record<string, string> = {};

    for (const member of members) {
      labels[member.key] = member.label;
    }

    return of({ lead: resolved[0], members: resolved, labels });
  }

  @Reduce()
  onSelectMetric(state: MetricsState, selection: Selected): MetricsState {
    // A rate is meaningless for a gauge and the only sane reading of a
    // monotonic counter, so the toggle follows the instrument by default.
    return {
      ...state,
      selected: selection.lead,
      members: selection.members,
      labels: selection.labels,
      rate: selection.lead.kind === 'sum' && selection.lead.monotonic === 1,
      // A different metric carries different attributes, so a split or a
      // filter made of the last one's keys would quietly match nothing.
      facets: [],
      window: null,
      split: [],
      where: {},
    };
  }

  @Effect()
  selectRange(range: Range): Observable<Range> {
    return of(range);
  }

  @Reduce()
  onSelectRange(state: MetricsState, range: Range): MetricsState {
    return { ...state, range };
  }

  @Effect()
  toggleRate(rate: boolean): Observable<boolean> {
    return of(rate);
  }

  @Reduce()
  onToggleRate(state: MetricsState, rate: boolean): MetricsState {
    return { ...state, rate };
  }

  @Effect()
  selectPercentile(percentile: number): Observable<number> {
    return of(percentile);
  }

  @Reduce()
  onSelectPercentile(state: MetricsState, percentile: number): MetricsState {
    return { ...state, percentile };
  }

  /** What a split or a filter can be made of, for the metric now selected. */
  @Effect()
  loadFacets(metric: MetricSummary): Observable<MetricFacet[]> {
    return from(
      this.request<MetricFacet[]>('POST', '/metrics/facets', {
        name: metric.name,
        kind: metric.kind,
        ...resolve(this.snapshot().range),
      }),
    );
  }

  @Reduce()
  onLoadFacets(state: MetricsState, facets: MetricFacet[]): MetricsState {
    return { ...state, facets };
  }

  /**
   * What the window held, beside the percentile estimated from it.
   *
   * Only for a histogram: the other kinds carry a value rather than a
   * distribution, and have nothing to count or average.
   */
  @Effect()
  loadWindow(query: SeriesQuery): Observable<MetricWindowSummary | null> {
    const metric = query.members[0];

    if (!metric || metric.kind !== 'histogram') {
      return of(null);
    }

    return from(
      this.request<MetricWindowSummary>('POST', '/metrics/summary', {
        name: metric.name,
        kind: metric.kind,
        where: query.where,
        ...resolve(query.range),
      }),
    );
  }

  @Reduce()
  onLoadWindow(state: MetricsState, window: MetricWindowSummary | null): MetricsState {
    return { ...state, window };
  }

  @Effect()
  selectSplit(keys: string[]): Observable<string[]> {
    return of(keys);
  }

  @Reduce()
  onSelectSplit(state: MetricsState, split: string[]): MetricsState {
    return { ...state, split };
  }

  @Effect()
  selectFilter(filter: Filter): Observable<Filter> {
    return of(filter);
  }

  /** An empty selection means "all of them", so the key is dropped rather than
   * kept as an empty list, which would match nothing. */
  @Reduce()
  onSelectFilter(state: MetricsState, filter: Filter): MetricsState {
    const where = { ...state.where };

    if (filter.values.length > 0) {
      where[filter.key] = filter.values;
    } else {
      delete where[filter.key];
    }

    return { ...state, where };
  }

  /**
   * One request per metric on the card, merged into one set of lines.
   *
   * They share an axis because they share a unit — that is what makes them one
   * card and one chart. A member whose series already carries attributes keeps
   * them, after its own name, so `peak · host=a` stays distinguishable from
   * `usage · host=a`.
   */
  @Effect()
  loadSeries(query: SeriesQuery): Observable<SeriesPoint[]> {
    const alone = query.members.length === 1;

    const lines = query.members.map(async (metric) => {
      const points = await this.request<SeriesPoint[]>('POST', '/metrics/query', {
        name: metric.name,
        kind: metric.kind,
        bucketSeconds: bucketOf(query.range).seconds,
        ...resolve(query.range),
        // A rate is a counter's reading; asking a gauge for one would be asking
        // how fast a temperature is a temperature.
        rate: query.rate && metric.kind === 'sum',
        // Only a histogram carries a distribution to take a percentile of.
        percentile: metric.kind === 'histogram' ? query.percentile : undefined,
        groupBy: query.split,
        where: query.where,
        limit: 10_000,
      });

      if (alone) {
        return points;
      }

      const label = query.labels[`${metric.name}|${metric.kind}`] ?? metric.name;

      return points.map((point) => ({
        ...point,
        series: point.series ? `${label} · ${point.series}` : label,
      }));
    });

    return from(Promise.all(lines).then((all) => onTheGrid(all.flat(), query.range)));
  }

  @Reduce()
  onLoadSeries(state: MetricsState, points: SeriesPoint[]): MetricsState {
    return { ...state, points };
  }

  /**
   * The cap this metric should be read against, from the resource that
   * reported it.
   *
   * It used to be a sibling metric — `x.usage` looked for `x.limit` — and a
   * limit is not a measurement: it is a property of the container, it cannot
   * change without a restart, and as a series it was a flat line that had to be
   * kept out of every axis it landed on. It rides on the resource now, so this
   * is a lookup rather than a query, and it is absent when nothing is capped.
   */
  @Effect()
  loadReference(metric: MetricSummary): Observable<number | null> {
    const ceiling = Number(metric.limits?.[`${scopeOf(metric.name)}.limit`]);

    return of(Number.isFinite(ceiling) && ceiling > 0 ? ceiling : null);
  }

  @Reduce()
  onLoadReference(state: MetricsState, reference: number | null): MetricsState {
    return { ...state, reference };
  }

  private fetchOverview(range: Range): Observable<MetricOverview[]> {
    return from(
      this.request<MetricOverview[]>('POST', '/metrics/overview', {
        ...resolve(range),
        // Coarser than the detail chart on purpose: a card is a couple of
        // hundred pixels wide, and more points than that is detail nobody can
        // see. Sixty buckets across whatever the window is.
        bucketSeconds: Math.max(Math.round(spanMinutes(range)), 1),
      }),
    );
  }

  /** Picks something to show on first load, so the page is never an empty
   * chart, and keeps the selection pointing at the freshly loaded entry. */
  private withOverview(state: MetricsState, overview: MetricOverview[]): MetricsState {
    const selected =
      overview.find(
        (metric) => metric.name === state.selected?.name && metric.kind === state.selected?.kind,
      ) ??
      overview[0] ??
      null;

    return { ...state, overview, catalogue: overview, selected };
  }

  private snapshot(): MetricsState {
    return this._store$.getValue();
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      // The scope rides on every body rather than on each call site, so a
      // new query cannot forget it.
      body: body ? JSON.stringify({ ...(body as object), app: this.scope.current }) : undefined,
    });

    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(detail?.error ?? `${method} ${path} failed with ${response.status}`);
    }

    return (await response.json()) as T;
  }
}

/**
 * Every series on the same grid of buckets, with the quiet ones left empty.
 *
 * The chart plots by position, so a window with nothing in it between one
 * o'clock and nine compresses eight hours into the gap between two points: the
 * axis then reads 13:00, 21:30 at the same spacing as 13:00, 14:00, and the
 * shape in between is an invention. Filling the grid makes position mean time
 * again.
 *
 * Empty rather than zero, because for most instruments they are different
 * claims. A gauge that was not sampled is not a gauge reading nought, and a
 * line drawn down to the axis and back says the machine idled when the truth
 * is nobody asked it.
 */
function onTheGrid(points: SeriesPoint[], range: Range): SeriesPoint[] {
  if (points.length === 0) {
    return points;
  }

  const { from, to } = resolve(range);
  const step = bucketOf(range).seconds * 1000;
  const first = Math.floor(Date.parse(from) / step) * step;
  const last = Math.floor(Date.parse(to) / step) * step;

  // Beyond this the fill costs more than the honesty buys: a seven-day window
  // at ten-second buckets is sixty thousand points per series.
  if ((last - first) / step > 2_000) {
    return points;
  }

  const held = new Map(points.map((point) => [`${point.bucket}|${point.series}`, point]));
  const names = [...new Set(points.map((point) => point.series))];
  const dense: SeriesPoint[] = [];

  for (let at = first; at <= last; at += step) {
    const bucket = clickHouseTime(at);

    for (const series of names) {
      dense.push(held.get(`${bucket}|${series}`) ?? { bucket, series, value: null });
    }
  }

  return dense;
}

/** ClickHouse renders its buckets as `YYYY-MM-DD hh:mm:ss` in UTC; a generated
 * one has to match exactly to line up with the ones it returned. */
function clickHouseTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19);
}
