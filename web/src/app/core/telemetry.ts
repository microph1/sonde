import { Injectable, inject } from '@angular/core';

import { API_BASE_URL } from './api-base-url';
import { LiveStream, liveStream } from './live-stream';
import { Auth } from './auth';
import { RowStream, streamRows } from './stream';
import { LogFilters, LogRecord, ServiceSummary, Span, TraceFilters } from './telemetry.model';

/**
 * The only place that knows the API exists.
 *
 * Search results come back as `RowStream`s rather than promises because the API
 * streams them: a view can render the first rows while the rest are still on
 * the wire, and cancel the request when the user changes the filters.
 */
@Injectable({ providedIn: 'root' })
export class Telemetry {
  private readonly baseUrl = inject(API_BASE_URL);
  private readonly auth = inject(Auth);

  /** Handed to every stream so an expired session restarts the login rather
   * than surfacing as a failed query. */
  private readonly reauthenticate = () => this.auth.login();

  async services(): Promise<ServiceSummary[]> {
    const response = await fetch(`${this.baseUrl}/services`);

    if (!response.ok) {
      throw new Error(`could not load services (${response.status})`);
    }

    return (await response.json()) as ServiceSummary[];
  }

  searchTraces(filters: TraceFilters): RowStream<Span> {
    return this.search<Span>('/traces/search', filters);
  }

  searchLogs(filters: LogFilters): RowStream<LogRecord> {
    return this.search<LogRecord>('/logs/search', filters);
  }

  trace(traceId: string): RowStream<Span> {
    return streamRows<Span>(
      (signal) =>
        fetch(`${this.baseUrl}/traces/${traceId}`, { signal, credentials: 'include' }),
      this.reauthenticate,
    );
  }

  /** Live tail of logs matching the filters, as server-sent events. */
  tailLogs(filters: LogFilters): LiveStream<LogRecord> {
    return liveStream<LogRecord>(this.tailUrl('/logs/tail', filters), this.reauthenticate);
  }

  /** Live tail of spans matching the filters, as server-sent events. */
  tailTraces(filters: TraceFilters): LiveStream<Span> {
    return liveStream<Span>(this.tailUrl('/traces/tail', filters), this.reauthenticate);
  }

  /** An EventSource can only issue a GET, so a tail carries its filters in the
   * query string; blank ones are dropped so the URL reads as what was asked. */
  private tailUrl(path: string, filters: object): string {
    const query = new URLSearchParams();

    for (const [name, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== "" && value !== 0) {
        query.set(name, String(value));
      }
    }

    const suffix = query.size > 0 ? `?${query}` : '';

    return `${this.baseUrl}${path}${suffix}`;
  }

  private search<T>(path: string, filters: object): RowStream<T> {
    return streamRows<T>((signal) =>
      fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filters),
        signal,
        credentials: 'include',
      }),
      this.reauthenticate,
    );
  }
}
