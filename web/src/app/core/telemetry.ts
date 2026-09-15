import { Injectable, inject } from '@angular/core';

import { API_BASE_URL } from './api-base-url';
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
    return streamRows<Span>((signal) => fetch(`${this.baseUrl}/traces/${traceId}`, { signal }));
  }

  private search<T>(path: string, filters: object): RowStream<T> {
    return streamRows<T>((signal) =>
      fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filters),
        signal,
      }),
    );
  }
}
