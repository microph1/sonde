import { Injectable, inject } from '@angular/core';

import { API_BASE_URL } from './api-base-url';
import { AppScope } from './app-scope';
import { ServiceSummary, VolumePoint } from './telemetry.model';

/**
 * The plain request/response half of the API.
 *
 * Streaming endpoints do not live here — they are observables built in the
 * stores, where cancellation and batching are the store's `switchMap` and
 * `bufferTime` rather than anything hand-written.
 */
@Injectable({ providedIn: 'root' })
export class Telemetry {
  private readonly baseUrl = inject(API_BASE_URL);
  private readonly scope = inject(AppScope);

  async services(): Promise<ServiceSummary[]> {
    return this.get<ServiceSummary[]>('/services');
  }

  /** Volume per group over a window, for the overview charts. The window
   * travels as two instants, so it can be one that has already ended. */
  async timeseries(
    window: { from: string; to: string },
    bucketSeconds: number,
    grouping: string,
  ): Promise<VolumePoint[]> {
    const params = new URLSearchParams({
      from: window.from,
      to: window.to,
      bucketSeconds: String(bucketSeconds),
      group: grouping,
    });

    return this.get<VolumePoint[]>(`/services/timeseries?${params}`);
  }

  /** The dimensions the charts may be split by. */
  async groupings(): Promise<{ key: string; label: string }[]> {
    return this.get<{ key: string; label: string }[]>('/groupings');
  }

  /** Every read is of one app's telemetry, so the scope is appended here rather
   * than at each call site, where a new endpoint would be able to forget it. */
  private async get<T>(path: string): Promise<T> {
    const separator = path.includes('?') ? '&' : '?';
    const scoped = `${path}${separator}app=${encodeURIComponent(this.scope.current)}`;
    const response = await fetch(`${this.baseUrl}${scoped}`, { credentials: 'include' });

    if (!response.ok) {
      throw new Error(`${path} failed with ${response.status}`);
    }

    return (await response.json()) as T;
  }
}
