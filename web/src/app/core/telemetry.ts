import { Injectable, inject } from '@angular/core';

import { API_BASE_URL } from './api-base-url';
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

  async services(): Promise<ServiceSummary[]> {
    return this.get<ServiceSummary[]>('/services');
  }

  /** Volume per group over a window, for the overview charts. */
  async timeseries(
    windowMinutes: number,
    bucketSeconds: number,
    grouping: string,
  ): Promise<VolumePoint[]> {
    return this.get<VolumePoint[]>(
      `/services/timeseries?windowMinutes=${windowMinutes}&bucketSeconds=${bucketSeconds}&group=${grouping}`,
    );
  }

  /** The dimensions the charts may be split by. */
  async groupings(): Promise<{ key: string; label: string }[]> {
    return this.get<{ key: string; label: string }[]>('/groupings');
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, { credentials: 'include' });

    if (!response.ok) {
      throw new Error(`${path} failed with ${response.status}`);
    }

    return (await response.json()) as T;
  }
}
