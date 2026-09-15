import { Signal, signal } from '@angular/core';

import { readNdjson } from './ndjson';

export type StreamState = 'idle' | 'streaming' | 'done' | 'error';

export interface RowStream<T> {
  readonly rows: Signal<readonly T[]>;
  readonly state: Signal<StreamState>;
  readonly error: Signal<string | null>;
  /** Stops reading and aborts the request; safe to call more than once. */
  cancel(): void;
}

/** Rows are flushed to the signal in batches: a change-detection pass per row
 * would dominate the cost of a fast query, and a 60 ms cadence still looks
 * continuous. */
const FLUSH_INTERVAL_MS = 60;

export function streamRows<T>(request: (signal: AbortSignal) => Promise<Response>): RowStream<T> {
  const rows = signal<readonly T[]>([]);
  const state = signal<StreamState>('idle');
  const error = signal<string | null>(null);
  const controller = new AbortController();

  let pending: T[] = [];
  let flushHandle: ReturnType<typeof setInterval> | undefined;

  const flush = (): void => {
    if (pending.length === 0) {
      return;
    }

    const batch = pending;
    pending = [];
    rows.update((current) => [...current, ...batch]);
  };

  const stop = (): void => {
    if (flushHandle !== undefined) {
      clearInterval(flushHandle);
      flushHandle = undefined;
    }
    flush();
  };

  void (async () => {
    state.set('streaming');
    flushHandle = setInterval(flush, FLUSH_INTERVAL_MS);

    try {
      const response = await request(controller.signal);

      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `request failed with ${response.status}`);
      }

      if (!response.body) {
        throw new Error('response had no body');
      }

      for await (const row of readNdjson<T>(response.body)) {
        pending.push(row);
      }

      stop();
      state.set('done');
    } catch (cause) {
      stop();

      // An abort is the caller changing their mind, not a failure to report.
      if (controller.signal.aborted) {
        state.set('done');
        return;
      }

      error.set(cause instanceof Error ? cause.message : String(cause));
      state.set('error');
    }
  })();

  return {
    rows: rows.asReadonly(),
    state: state.asReadonly(),
    error: error.asReadonly(),
    cancel: () => {
      controller.abort();
      stop();
    },
  };
}
