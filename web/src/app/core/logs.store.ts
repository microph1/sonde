import { Injectable, inject } from '@angular/core';
import { Effect, Reduce, Store, makeStore } from '@microphi/store';
import { EMPTY, Observable, bufferTime, filter, from, scan, startWith } from 'rxjs';

import { API_BASE_URL } from './api-base-url';
import { AppScope } from './app-scope';
import { ndjsonRows, sseEvents } from './ndjson-stream';
import { LogFilters, LogRecord, SeriesPoint } from './telemetry.model';
import { FLUSH_MS, MAX_LIVE_ROWS, accumulate, tailUrl } from './traces.store';

export interface LogsState {
  rows: LogRecord[];
  /** The same search, counted per bucket and severity band. */
  histogram: SeriesPoint[];
  live: boolean;
}

export interface LogsActions {
  search: (filters: LogFilters) => Observable<LogRecord[]>;
  histogram: (filters: LogFilters & { bucketSeconds: number }) => Observable<SeriesPoint[]>;
  tail: (filters: LogFilters) => Observable<LogRecord[]>;
  stop: () => Observable<void>;
}

/** Same shape as [`TracesStore`], over the log signal. The two are kept
 * separate rather than generic because their filters and their rows have
 * nothing in common but the transport. */
@Injectable({ providedIn: 'root' })
export class LogsStore
  extends Store<LogsState, LogsActions>
  implements makeStore<LogsState, LogsActions>
{
  private readonly baseUrl = inject(API_BASE_URL);
  /** Every query is of one app's telemetry; the scope says which. */
  private readonly scope = inject(AppScope);

  readonly rows$ = this.select((state) => state.rows);
  readonly histogram$ = this.select((state) => state.histogram);
  readonly live$ = this.select((state) => state.live);

  constructor() {
    super({ rows: [], histogram: [], live: false });
  }

  /**
   * The shape of the same search.
   *
   * A separate action rather than part of `search`: the two are different
   * queries with different costs, and a per-action switchMap means a search
   * that is replaced mid-flight abandons both cleanly.
   */
  @Effect()
  histogram(filters: LogFilters & { bucketSeconds: number }): Observable<SeriesPoint[]> {
    return from(
      fetch(`${this.baseUrl}/logs/histogram`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...filters, app: this.scope.current }),
        credentials: 'include',
      }).then((response) => (response.ok ? (response.json() as Promise<SeriesPoint[]>) : [])),
    );
  }

  @Reduce()
  onHistogram(state: LogsState, histogram: SeriesPoint[]): LogsState {
    return { ...state, histogram };
  }

  @Effect()
  search(filters: LogFilters): Observable<LogRecord[]> {
    return ndjsonRows<LogRecord>((signal) =>
      fetch(`${this.baseUrl}/logs/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...filters, app: this.scope.current }),
        credentials: 'include',
        signal,
      }),
    ).pipe(accumulate());
  }

  @Reduce()
  onSearch(state: LogsState, rows: LogRecord[]): LogsState {
    return { ...state, rows, live: false };
  }

  @Effect()
  tail(filters: LogFilters): Observable<LogRecord[]> {
    return sseEvents<LogRecord>(tailUrl(this.baseUrl, '/logs/tail', { ...filters, app: this.scope.current })).pipe(
      bufferTime(FLUSH_MS),
      filter((batch) => batch.length > 0),
      scan(
        (rows: LogRecord[], batch) => [...batch.reverse(), ...rows].slice(0, MAX_LIVE_ROWS),
        [],
      ),
      // Marks the tail live before the first record; see TracesStore.
      startWith([] as LogRecord[]),
    );
  }

  @Reduce()
  onTail(state: LogsState, rows: LogRecord[]): LogsState {
    return { ...state, rows, live: true };
  }

  @Effect()
  stop(): Observable<void> {
    return EMPTY;
  }

  @Reduce()
  onStop(state: LogsState): LogsState {
    return { ...state, live: false };
  }
}
