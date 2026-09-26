import { Injectable, inject } from '@angular/core';
import { Effect, Reduce, Store, makeStore } from '@microphi/store';
import { EMPTY, Observable, combineLatest, from, map, of } from 'rxjs';

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
}

export interface MetricsState {
  catalogue: MetricSummary[];
  selected: MetricSummary | null;
  points: SeriesPoint[];
  range: Range;
  rate: boolean;
  /** The cap a `.usage` gauge should be read against, when it reports one. */
  reference: number | null;
}

export interface MetricsActions {
  loadCatalogue: () => Observable<MetricSummary[]>;
  selectMetric: (key: string) => Observable<MetricSummary>;
  selectRange: (range: Range) => Observable<Range>;
  toggleRate: (rate: boolean) => Observable<boolean>;
  loadSeries: (query: SeriesQuery) => Observable<SeriesPoint[]>;
  loadReference: (metric: MetricSummary) => Observable<number | null>;
}

export interface SeriesQuery {
  readonly metric: MetricSummary;
  readonly range: Range;
  readonly rate: boolean;
}

@Injectable({ providedIn: 'root' })
export class MetricsStore
  extends Store<MetricsState, MetricsActions>
  implements makeStore<MetricsState, MetricsActions>
{
  private readonly baseUrl = inject(API_BASE_URL);

  readonly catalogue$ = this.select((state) => state.catalogue);
  readonly selected$ = this.select((state) => state.selected);
  readonly points$ = this.select((state) => state.points);
  readonly range$ = this.select((state) => state.range);
  readonly rate$ = this.select((state) => state.rate);
  readonly reference$ = this.select((state) => state.reference);

  constructor() {
    super({
      catalogue: [],
      selected: null,
      points: [],
      // Metrics are sampled minutes apart, so the overview's one-hour default
      // would show a handful of points; a day is the smallest window with shape.
      range: RANGES[2],
      rate: false,
      reference: null,
    });

    // The series follows all three, so the store owns the link rather than
    // asking the view to remember which of them require a reload.
    combineLatest([this.selected$, this.range$, this.rate$]).subscribe(
      ([metric, range, rate]) => {
        if (metric) {
          this.dispatch('loadSeries', { metric, range, rate });
          this.dispatch('loadReference', metric);
        }
      },
    );
  }

  @Effect()
  loadCatalogue(): Observable<MetricSummary[]> {
    return from(this.request<MetricSummary[]>('GET', '/metrics'));
  }

  /** Picks something to show on first load, so the page is never an empty
   * chart with a dropdown. */
  @Reduce()
  onLoadCatalogue(state: MetricsState, catalogue: MetricSummary[]): MetricsState {
    return { ...state, catalogue, selected: state.selected ?? catalogue[0] ?? null };
  }

  /** Takes a `name|kind` key rather than the object, so the view can dispatch
   * straight from a select element without resolving anything itself. */
  @Effect()
  selectMetric(key: string): Observable<MetricSummary> {
    const [name, kind] = key.split('|');
    const found = this._store$
      .getValue()
      .catalogue.find((metric) => metric.name === name && metric.kind === kind);

    return found ? of(found) : EMPTY;
  }

  @Reduce()
  onSelectMetric(state: MetricsState, selected: MetricSummary): MetricsState {
    // A rate is meaningless for a gauge and the only sane reading of a
    // monotonic counter, so the toggle follows the instrument by default.
    return { ...state, selected, rate: selected.kind === 'sum' && selected.monotonic === 1 };
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
  loadSeries(query: SeriesQuery): Observable<SeriesPoint[]> {
    return from(
      this.request<SeriesPoint[]>('POST', '/metrics/query', {
        name: query.metric.name,
        kind: query.metric.kind,
        bucketSeconds: query.range.bucketSeconds,
        from: new Date(Date.now() - query.range.windowMinutes * 60_000).toISOString(),
        rate: query.rate,
        limit: 10_000,
      }),
    );
  }

  @Reduce()
  onLoadSeries(state: MetricsState, points: SeriesPoint[]): MetricsState {
    return { ...state, points };
  }

  /**
   * The cap for a `.usage` gauge, when the instrument also reports a `.limit`.
   *
   * Drawn as a reference line rather than a second series: a limit is a
   * constant two orders of magnitude above the usage, and plotting it as a
   * series would flatten the one anyone is trying to read. Returns null when
   * there is no sibling — the relay reports no limit in dev, where the cgroup
   * reads `max`.
   */
  @Effect()
  loadReference(metric: MetricSummary): Observable<number | null> {
    if (!metric.name.endsWith('.usage')) {
      return of(null);
    }

    const name = metric.name.replace(/\.usage$/, '.limit');

    if (!this._store$.getValue().catalogue.some((entry) => entry.name === name)) {
      return of(null);
    }

    return from(
      this.request<SeriesPoint[]>('POST', '/metrics/query', {
        name,
        kind: 'gauge',
        bucketSeconds: 3600,
        limit: 10,
      }),
    ).pipe(map((points) => points.at(-1)?.value ?? null));
  }

  @Reduce()
  onLoadReference(state: MetricsState, reference: number | null): MetricsState {
    return { ...state, reference };
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
