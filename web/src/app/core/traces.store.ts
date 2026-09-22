import { Injectable, inject } from '@angular/core';
import { Effect, Reduce, Store, makeStore } from '@microphi/store';
import { EMPTY, Observable, bufferTime, filter, scan, startWith } from 'rxjs';

import { API_BASE_URL } from './api-base-url';
import { ndjsonRows, sseEvents } from './ndjson-stream';
import { Span, TraceFilters } from './telemetry.model';

export interface TracesState {
  rows: Span[];
  /** A single trace's spans, oldest first — the order a waterfall renders in. */
  trace: Span[];
  live: boolean;
}

export interface TracesActions {
  search: (filters: TraceFilters) => Observable<Span[]>;
  tail: (filters: TraceFilters) => Observable<Span[]>;
  loadTrace: (traceId: string) => Observable<Span[]>;
  stop: () => Observable<void>;
}

/** Rows arrive far faster than anyone reads them; a frame's worth per update
 * looks continuous and costs one change-detection pass instead of hundreds. */
const FLUSH_MS = 60;
/** A tail left open all day must not grow without end. */
const MAX_LIVE_ROWS = 1000;

/**
 * Traces search and live tail.
 *
 * Both are streams rather than requests, and the store's per-action `switchMap`
 * is what makes that safe: starting a search abandons the previous one, and
 * unsubscribing aborts its HTTP request, so an abandoned query stops occupying
 * the server rather than racing the new one into the same list.
 */
@Injectable({ providedIn: 'root' })
export class TracesStore
  extends Store<TracesState, TracesActions>
  implements makeStore<TracesState, TracesActions>
{
  private readonly baseUrl = inject(API_BASE_URL);

  readonly rows$ = this.select((state) => state.rows);
  readonly trace$ = this.select((state) => state.trace);
  readonly live$ = this.select((state) => state.live);

  constructor() {
    super({ rows: [], trace: [], live: false });
  }

  @Effect()
  search(filters: TraceFilters): Observable<Span[]> {
    return ndjsonRows<Span>((signal) =>
      fetch(`${this.baseUrl}/traces/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filters),
        credentials: 'include',
        signal,
      }),
    ).pipe(accumulate());
  }

  @Reduce()
  onSearch(state: TracesState, rows: Span[]): TracesState {
    return { ...state, rows, live: false };
  }

  @Effect()
  tail(filters: TraceFilters): Observable<Span[]> {
    return sseEvents<Span>(tailUrl(this.baseUrl, '/traces/tail', filters)).pipe(
      // Newest first, and bounded: the opposite of a search, which arrives in
      // the order the query returned it.
      bufferTime(FLUSH_MS),
      filter((batch) => batch.length > 0),
      scan((rows: Span[], batch) => [...batch.reverse(), ...rows].slice(0, MAX_LIVE_ROWS), []),
      // A reducer only runs when its effect emits, and a quiet tail emits
      // nothing — without this the UI would not say "live" until the first row
      // happened to arrive, which for an idle service is never. It also clears
      // the previous search, which is what switching to a tail means.
      startWith([] as Span[]),
    );
  }

  @Reduce()
  onTail(state: TracesState, rows: Span[]): TracesState {
    return { ...state, rows, live: true };
  }

  @Effect()
  loadTrace(traceId: string): Observable<Span[]> {
    return ndjsonRows<Span>((signal) =>
      fetch(`${this.baseUrl}/traces/${traceId}`, { credentials: 'include', signal }),
    ).pipe(accumulate());
  }

  /** Replaces rather than merges: opening a trace is a fresh subject, and
   * leaving the previous one behind would draw two waterfalls at once. */
  @Reduce()
  onLoadTrace(state: TracesState, trace: Span[]): TracesState {
    return { ...state, trace };
  }

  /** Ends whichever stream is running. Dispatching any action cancels the
   * previous one through `switchMap`; this is the action that starts nothing in
   * its place. */
  @Effect()
  stop(): Observable<void> {
    return EMPTY;
  }

  @Reduce()
  onStop(state: TracesState): TracesState {
    return { ...state, live: false };
  }
}

/**
 * Batches rows and folds them into a growing list.
 *
 * This is the whole of what used to be a hand-written flush timer, a pending
 * buffer and an array the caller kept appending to.
 */
export function accumulate<T>() {
  return (source: Observable<T>): Observable<T[]> =>
    source.pipe(
      bufferTime(FLUSH_MS),
      filter((batch) => batch.length > 0),
      scan((rows: T[], batch) => [...rows, ...batch], []),
    );
}

/** An EventSource can only issue a GET, so a tail carries its filters in the
 * query string; blank ones are dropped so the URL reads as what was asked. */
export function tailUrl(baseUrl: string, path: string, filters: object): string {
  const query = new URLSearchParams();

  for (const [name, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '' && value !== 0) {
      query.set(name, String(value));
    }
  }

  return `${baseUrl}${path}${query.size > 0 ? `?${query}` : ''}`;
}

/** Re-exported so the logs store shares one definition of "a frame's worth". */
export { FLUSH_MS, MAX_LIVE_ROWS };
