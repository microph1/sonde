import { Injectable, inject } from '@angular/core';
import { Effect, Reduce, Store, makeStore } from '@microphi/store';
import { EMPTY, Observable, bufferTime, filter, scan, startWith } from 'rxjs';

import { API_BASE_URL } from './api-base-url';
import { ndjsonRows, sseEvents } from './ndjson-stream';
import { LogFilters, LogRecord } from './telemetry.model';
import { FLUSH_MS, MAX_LIVE_ROWS, accumulate, tailUrl } from './traces.store';

export interface LogsState {
  rows: LogRecord[];
  live: boolean;
}

export interface LogsActions {
  search: (filters: LogFilters) => Observable<LogRecord[]>;
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

  readonly rows$ = this.select((state) => state.rows);
  readonly live$ = this.select((state) => state.live);

  constructor() {
    super({ rows: [], live: false });
  }

  @Effect()
  search(filters: LogFilters): Observable<LogRecord[]> {
    return ndjsonRows<LogRecord>((signal) =>
      fetch(`${this.baseUrl}/logs/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filters),
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
    return sseEvents<LogRecord>(tailUrl(this.baseUrl, '/logs/tail', filters)).pipe(
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
