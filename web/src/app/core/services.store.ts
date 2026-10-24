import { Injectable, inject } from '@angular/core';
import { Effect, Reduce, Store, makeStore } from '@microphi/store';
import { Observable, combineLatest, from, map, of } from 'rxjs';

import { Telemetry } from './telemetry';
import { ServiceSummary, VolumePoint } from './telemetry.model';
import { DEFAULT_RANGE, TimeRange, bucketOf, resolve } from './time-range';

/**
 * Re-exported from [`time-range`], which is where a window is defined now that
 * one can be absolute as well as relative. Kept here because every store and
 * page imports `Range` from this file, and a rename across all of them would
 * say nothing the alias does not.
 */
export { RANGES } from './time-range';
export { DEFAULT_RANGE };
export type Range = TimeRange;

export interface ServicesState {
  services: ServiceSummary[];
  volume: VolumePoint[];
  range: Range;
  /** Which dimension the charts split by. */
  grouping: string;
  groupings: Grouping[];
}

export interface Grouping {
  readonly key: string;
  readonly label: string;
}

export interface ServicesActions {
  loadServices: () => Observable<ServiceSummary[]>;
  loadVolume: (query: VolumeQuery) => Observable<VolumePoint[]>;
  selectRange: (range: Range) => Observable<Range>;
  selectGrouping: (grouping: string) => Observable<string>;
  loadGroupings: () => Observable<Grouping[]>;
}

/** The charts are a function of both, so they travel together — a request for
 * one range grouped one way. */
export interface VolumeQuery {
  readonly range: Range;
  readonly grouping: string;
}

/**
 * The overview's state.
 *
 * Both loads are dispatched rather than called: the store's per-action
 * switchMap means changing the range mid-flight abandons the previous request
 * instead of racing it, and `loading$` reports progress without a hand-rolled
 * flag beside every call.
 */
@Injectable({ providedIn: 'root' })
export class ServicesStore
  extends Store<ServicesState, ServicesActions>
  implements makeStore<ServicesState, ServicesActions>
{
  private readonly telemetry = inject(Telemetry);

  readonly services$ = this.select((state) => state.services);
  readonly volume$ = this.select((state) => state.volume);
  readonly range$ = this.select((state) => state.range);
  readonly grouping$ = this.select((state) => state.grouping);
  readonly groupings$ = this.select((state) => state.groupings);

  constructor() {
    super({ services: [], volume: [], range: DEFAULT_RANGE, grouping: 'service', groupings: [] });

    // The points are a function of the range and the grouping, so the store
    // owns that link rather than asking every view to remember to dispatch a
    // reload after each. `select` rides the state BehaviorSubject, so this also
    // fires on construction — entering the page needs no separate load.
    combineLatest([this.range$, this.grouping$]).subscribe(([range, grouping]) =>
      this.dispatch('loadVolume', { range, grouping }),
    );
  }

  @Effect()
  loadServices(): Observable<ServiceSummary[]> {
    return from(this.telemetry.services());
  }

  @Reduce()
  onLoadServices(state: ServicesState, services: ServiceSummary[]): ServicesState {
    return { ...state, services };
  }

  @Effect()
  loadVolume(query: VolumeQuery): Observable<VolumePoint[]> {
    const window = resolve(query.range);
    const bucket = bucketOf(query.range);

    return from(this.telemetry.timeseries(window, bucket.seconds, query.grouping)).pipe(
      // Densified against the same window the request named, so a gap reads as
      // zero rather than as a straight line between two distant points.
      map((points) => densify(points, window, bucket.seconds)),
    );
  }

  @Effect()
  selectGrouping(grouping: string): Observable<string> {
    return of(grouping);
  }

  @Reduce()
  onSelectGrouping(state: ServicesState, grouping: string): ServicesState {
    return { ...state, grouping };
  }

  @Effect()
  loadGroupings(): Observable<Grouping[]> {
    return from(this.telemetry.groupings());
  }

  @Reduce()
  onLoadGroupings(state: ServicesState, groupings: Grouping[]): ServicesState {
    return { ...state, groupings };
  }

  /**
   * The range is recorded from the action's payload rather than set separately,
   * so the range on screen is always the one the rendered points came from —
   * they cannot drift apart while a request is in flight.
   */
  @Reduce()
  onLoadVolume(state: ServicesState, volume: VolumePoint[]): ServicesState {
    return { ...state, volume };
  }

  /** Carries the chosen range into state. The reducer for `loadVolume` cannot
   * do it — a reducer sees its effect's output, and that output is the points,
   * not the range they were asked for. */
  @Effect()
  selectRange(range: Range): Observable<Range> {
    return of(range);
  }

  @Reduce()
  onSelectRange(state: ServicesState, range: Range): ServicesState {
    return { ...state, range };
  }

}

/**
 * Fills in the buckets ClickHouse had nothing to report for.
 *
 * The query returns only buckets that contain rows, so a quiet night comes back
 * as a handful of points — and a chart that plots by position would draw them
 * evenly across the window, turning fifteen minutes of traffic into a shape
 * that looks like a day of it. Every service gets a value at every bucket, so
 * position means time and a gap reads as zero rather than as a straight line
 * between two distant points.
 */
export function densify(
  points: VolumePoint[],
  window: { from: string; to: string },
  bucketSeconds: number,
): VolumePoint[] {
  if (points.length === 0) {
    return points;
  }

  const stepMs = bucketSeconds * 1000;
  // Align to the same boundaries ClickHouse used, so filled buckets land on the
  // grid rather than beside it.
  const last = Math.floor(Date.parse(window.to) / stepMs) * stepMs;
  const first = Math.floor(Date.parse(window.from) / stepMs) * stepMs;

  const services = [...new Set(points.map((point) => point.ServiceName))];
  const byKey = new Map(points.map((point) => [`${point.bucket}|${point.ServiceName}`, point]));

  const dense: VolumePoint[] = [];

  for (let time = first; time <= last; time += stepMs) {
    const bucket = clickHouseTime(time);

    for (const service of services) {
      dense.push(
        byKey.get(`${bucket}|${service}`) ?? {
          bucket,
          ServiceName: service,
          spans: 0,
          logs: 0,
          errors: 0,
          spanErrors: 0,
          logErrors: 0,
        },
      );
    }
  }

  return dense;
}

/** ClickHouse renders its buckets as `YYYY-MM-DD hh:mm:ss` in UTC; generated
 * buckets have to match that exactly to line up with the ones it returned. */
function clickHouseTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19);
}
