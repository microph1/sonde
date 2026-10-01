import { Injectable, inject } from '@angular/core';
import { Effect, Reduce, Store, makeStore } from '@microphi/store';
import { EMPTY, Observable, combineLatest, from, map, of, skip } from 'rxjs';

import { API_BASE_URL } from './api-base-url';
import { RANGES, Range } from './services.store';
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
  /** The cap a `.usage` gauge should be read against, when it reports one. */
  reference: number | null;
}

export interface MetricsActions {
  loadCatalogue: () => Observable<MetricOverview[]>;
  loadOverview: (range: Range) => Observable<MetricOverview[]>;
  selectMetric: (members: Member[]) => Observable<Selected>;
  selectRange: (range: Range) => Observable<Range>;
  toggleRate: (rate: boolean) => Observable<boolean>;
  loadSeries: (query: SeriesQuery) => Observable<SeriesPoint[]>;
  loadReference: (metric: MetricSummary) => Observable<number | null>;
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

  readonly catalogue$ = this.select((state) => state.catalogue);
  readonly overview$ = this.select((state) => state.overview);
  readonly selected$ = this.select((state) => state.selected);
  readonly members$ = this.select((state) => state.members);
  readonly labels$ = this.select((state) => state.labels);
  readonly points$ = this.select((state) => state.points);
  readonly range$ = this.select((state) => state.range);
  readonly rate$ = this.select((state) => state.rate);
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
      reference: null,
    });

    // The series follows all three, so the store owns the link rather than
    // asking the view to remember which of them require a reload.
    combineLatest([this.selected$, this.members$, this.labels$, this.range$, this.rate$]).subscribe(
      ([metric, members, labels, range, rate]) => {
        if (metric) {
          this.dispatch('loadSeries', { members: members.length ? members : [metric], labels, range, rate });
          this.dispatch('loadReference', metric);
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
        bucketSeconds: query.range.bucketSeconds,
        from: new Date(Date.now() - query.range.windowMinutes * 60_000).toISOString(),
        // A rate is a counter's reading; asking a gauge for one would be asking
        // how fast a temperature is a temperature.
        rate: query.rate && metric.kind === 'sum',
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

    return from(Promise.all(lines).then((all) => all.flat()));
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
        from: new Date(Date.now() - range.windowMinutes * 60_000).toISOString(),
        // Coarser than the detail chart on purpose: a card is a couple of
        // hundred pixels wide, and more points than that is detail nobody can
        // see. Sixty buckets across whatever the window is.
        bucketSeconds: Math.max(Math.round(range.windowMinutes), 1),
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
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(detail?.error ?? `${method} ${path} failed with ${response.status}`);
    }

    return (await response.json()) as T;
  }
}
