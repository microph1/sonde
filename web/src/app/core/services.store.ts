import { Injectable, inject } from '@angular/core';
import { Effect, Reduce, Store, makeStore } from '@microphi/store';
import { Observable, from, of, tap } from 'rxjs';

import { Telemetry } from './telemetry';
import { ServiceSummary, VolumePoint } from './telemetry.model';

/** Windows offered above the charts, with a bucket that keeps every one of them
 * at roughly 50-70 points — dense enough to show shape, sparse enough to stay
 * readable at this width. */
export const RANGES = [
  { label: '1h', windowMinutes: 60, bucketSeconds: 60, bucketLabel: 'minute' },
  { label: '6h', windowMinutes: 360, bucketSeconds: 300, bucketLabel: '5 minutes' },
  { label: '24h', windowMinutes: 1440, bucketSeconds: 1800, bucketLabel: '30 minutes' },
  { label: '7d', windowMinutes: 10080, bucketSeconds: 10800, bucketLabel: '3 hours' },
] as const;

export type Range = (typeof RANGES)[number];

export interface ServicesState {
  services: ServiceSummary[];
  volume: VolumePoint[];
  range: Range;
}

export interface ServicesActions {
  loadServices: () => Observable<ServiceSummary[]>;
  loadVolume: (range: Range) => Observable<VolumePoint[]>;
  selectRange: (range: Range) => Observable<Range>;
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

  constructor() {
    super({ services: [], volume: [], range: restoreRange() });

    // The points always follow the range, so the store owns that link rather
    // than asking every view to remember to dispatch both. `select` rides the
    // state BehaviorSubject, so this also fires for the restored range on
    // construction — entering the page needs no separate load.
    this.range$.subscribe((range) => this.dispatch('loadVolume', range));
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
  loadVolume(range: Range): Observable<VolumePoint[]> {
    return from(this.telemetry.timeseries(range.windowMinutes, range.bucketSeconds));
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
    // Persisting is a side effect, so it lives in the effect; the reducer stays
    // a pure state transition.
    return of(range).pipe(tap(persistRange));
  }

  @Reduce()
  onSelectRange(state: ServicesState, range: Range): ServicesState {
    return { ...state, range };
  }

}

const RANGE_KEY = 'watchers.services.range';
const DEFAULT_RANGE = RANGES[2];

/**
 * Only the label is stored, and it is resolved against the current `RANGES`.
 * Persisting the whole object would pin a stale bucket size the day these
 * definitions change.
 */
function restoreRange(): Range {
  try {
    const label = localStorage.getItem(RANGE_KEY);

    return RANGES.find((range) => range.label === label) ?? DEFAULT_RANGE;
  } catch {
    // Storage can be unavailable (private mode, blocked cookies); a forgotten
    // preference is not worth failing the page over.
    return DEFAULT_RANGE;
  }
}

function persistRange(range: Range): void {
  try {
    localStorage.setItem(RANGE_KEY, range.label);
  } catch {
    // As above: best effort.
  }
}
