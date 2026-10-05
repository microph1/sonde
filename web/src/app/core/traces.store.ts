import { Injectable, inject } from '@angular/core';
import { Effect, Reduce, Store, makeStore } from '@microphi/store';
import { EMPTY, Observable, bufferTime, filter, from, map, scan, startWith } from 'rxjs';

import { API_BASE_URL } from './api-base-url';
import { ndjsonRows, sseEvents } from './ndjson-stream';
import { LogRecord, Span, TraceFilters, TraceRow } from './telemetry.model';

export interface TracesState {
  rows: TraceRow[];
  /**
   * Spans by trace id, oldest first — the order a waterfall renders in.
   *
   * Keyed rather than single, because more than one trace can be open at once
   * now: a list of expanded rows is several waterfalls on screen together, and
   * one slot would have meant every row but the newest going blank.
   */
  traces: Record<string, Span[]>;
  /**
   * Log records by trace id.
   *
   * A span says a thing took 40 ms; the log line says what it was doing. They
   * are two halves of one story and were two pages apart, even though every
   * record already carried the trace id that joins them.
   */
  logs: Record<string, LogRecord[]>;
  live: boolean;
}

export interface TracesActions {
  search: (filters: TraceFilters) => Observable<TraceRow[]>;
  tail: (filters: TraceFilters) => Observable<TraceRow[]>;
  loadTrace: (traceId: string) => Observable<Span[]>;
  loadLogs: (query: TraceLogsQuery) => Observable<TraceLogs>;
  stop: () => Observable<void>;
}

/**
 * Spans folded into the trace rows they belong to, newest trace first.
 *
 * Kept outside the store because it is arithmetic, not state: given the rows
 * so far and a batch of spans, it is the same answer every time.
 */
function fold(rows: TraceRow[], batch: Span[]): TraceRow[] {
  const byTrace = new Map(rows.map((row) => [row.TraceId, row]));

  for (const span of batch) {
    const started = Date.parse(span.Timestamp);
    const existing = byTrace.get(span.TraceId);
    const root = span.ParentSpanId === '';

    if (!existing) {
      byTrace.set(span.TraceId, {
        TraceId: span.TraceId,
        StartedAt: span.Timestamp,
        RootName: span.SpanName,
        RootService: span.ServiceName,
        Spans: 1,
        Services: 1,
        Errors: span.StatusCode === 'Error' ? 1 : 0,
        TotalDuration: span.Duration,
      });
      continue;
    }

    const earlier = started < Date.parse(existing.StartedAt);

    byTrace.set(span.TraceId, {
      ...existing,
      // A root that arrives late still gets to name the trace; otherwise the
      // earliest span seen does.
      RootName: root || earlier ? span.SpanName : existing.RootName,
      RootService: root || earlier ? span.ServiceName : existing.RootService,
      StartedAt: earlier ? span.Timestamp : existing.StartedAt,
      Spans: existing.Spans + 1,
      Services: existing.Services,
      Errors: existing.Errors + (span.StatusCode === 'Error' ? 1 : 0),
      TotalDuration: Math.max(existing.TotalDuration, span.Duration),
    });
  }

  return [...byTrace.values()]
    .sort((a, b) => b.StartedAt.localeCompare(a.StartedAt))
    .slice(0, MAX_LIVE_ROWS);
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
export interface TraceLogsQuery {
  readonly traceId: string;
  /** The window the trace was found in — a log search defaults to the last
   * hour, which for a trace opened from a seven-day search finds nothing. */
  readonly from: string;
}

export interface TraceLogs {
  readonly traceId: string;
  readonly records: LogRecord[];
}

@Injectable({ providedIn: 'root' })
export class TracesStore
  extends Store<TracesState, TracesActions>
  implements makeStore<TracesState, TracesActions>
{
  private readonly baseUrl = inject(API_BASE_URL);

  readonly rows$ = this.select((state) => state.rows);
  readonly traces$ = this.select((state) => state.traces);
  readonly logs$ = this.select((state) => state.logs);

  /** One trace's spans, for a view that is showing exactly that one. */
  spansFor(traceId: string): Observable<Span[]> {
    return this.traces$.pipe(map((traces) => traces[traceId] ?? []));
  }

  /** And the lines it logged. */
  logsFor(traceId: string): Observable<LogRecord[]> {
    return this.logs$.pipe(map((logs) => logs[traceId] ?? []));
  }
  readonly live$ = this.select((state) => state.live);

  constructor() {
    super({ rows: [], traces: {}, logs: {}, live: false });
  }

  @Effect()
  search(filters: TraceFilters): Observable<TraceRow[]> {
    return ndjsonRows<TraceRow>((signal) =>
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
  onSearch(state: TracesState, rows: TraceRow[]): TracesState {
    return { ...state, rows, live: false };
  }

  /**
   * The tail arrives as spans and is folded into the same trace rows the
   * search produces, so the list has one shape whichever way it was filled.
   *
   * A tailed trace is necessarily incomplete — its root may not have been
   * recorded yet, and more spans will arrive after the row does — so the row
   * grows in place: the earliest span seen names it until the root turns up,
   * and the counts and the span of time it covers widen as the rest lands.
   */
  @Effect()
  tail(filters: TraceFilters): Observable<TraceRow[]> {
    return sseEvents<Span>(tailUrl(this.baseUrl, '/traces/tail', filters)).pipe(
      bufferTime(FLUSH_MS),
      filter((batch) => batch.length > 0),
      scan((rows: TraceRow[], batch) => fold(rows, batch), []),
      // A reducer only runs when its effect emits, and a quiet tail emits
      // nothing — without this the UI would not say "live" until the first row
      // happened to arrive, which for an idle service is never. It also clears
      // the previous search, which is what switching to a tail means.
      startWith([] as TraceRow[]),
    );
  }

  @Reduce()
  onTail(state: TracesState, rows: TraceRow[]): TracesState {
    return { ...state, rows, live: true };
  }

  @Effect()
  loadTrace(traceId: string): Observable<Span[]> {
    return ndjsonRows<Span>((signal) =>
      fetch(`${this.baseUrl}/traces/${traceId}`, { credentials: 'include', signal }),
    ).pipe(accumulate());
  }

  /** Keyed by the trace the spans belong to, taken from the spans themselves:
   * the reducer is handed rows, not the id that was asked for, and a trace with
   * no spans has nothing to file.
   * leaving the previous one behind would draw two waterfalls at once. */
  @Reduce()
  onLoadTrace(state: TracesState, spans: Span[]): TracesState {
    const traceId = spans[0]?.TraceId;

    if (!traceId) {
      return state;
    }

    return { ...state, traces: { ...state.traces, [traceId]: spans } };
  }

  /** Ends whichever stream is running. Dispatching any action cancels the
   * previous one through `switchMap`; this is the action that starts nothing in
   * its place. */
  /**
   * Every log line recorded under a trace.
   *
   * One request when a trace is opened rather than one per span: a trace with
   * forty spans would otherwise be forty round trips to show what is one
   * query, and the client already knows which span each line belongs to —
   * every record carries the span id.
   */
  @Effect()
  loadLogs(query: TraceLogsQuery): Observable<TraceLogs> {
    return from(
      fetch(`${this.baseUrl}/logs/search`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ traceId: query.traceId, from: query.from, limit: 500 }),
      })
        .then((response) => (response.ok ? response.text() : ''))
        .then((body) => ({
          traceId: query.traceId,
          records: body
            .split('\n')
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as LogRecord),
        })),
    );
  }

  @Reduce()
  onLoadLogs(state: TracesState, loaded: TraceLogs): TracesState {
    return { ...state, logs: { ...state.logs, [loaded.traceId]: loaded.records } };
  }

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
