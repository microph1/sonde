import { Signal, signal } from '@angular/core';

export type LiveState = 'connecting' | 'live' | 'closed';

export interface LiveStream<T> {
  readonly rows: Signal<readonly T[]>;
  readonly state: Signal<LiveState>;
  /** Last activity from the server, including heartbeats. */
  readonly lastEvent: Signal<Date | null>;
  close(): void;
}

/** Newest first, bounded: a tail left open all day must not grow without end. */
const MAX_ROWS = 1000;

/**
 * Subscribes to a server-sent event stream.
 *
 * `EventSource` rather than `fetch` because it reconnects on its own and
 * replays `Last-Event-ID`, which is what a connection meant to stay open for
 * hours needs — and what a finite search deliberately does not.
 */
export function liveStream<T>(url: string, onUnauthorized?: () => void): LiveStream<T> {
  const rows = signal<readonly T[]>([]);
  const state = signal<LiveState>('connecting');
  const lastEvent = signal<Date | null>(null);

  const source = new EventSource(url, { withCredentials: true });

  source.addEventListener('open', () => state.set('live'));

  source.addEventListener('row', (event) => {
    lastEvent.set(new Date());
    state.set('live');
    rows.update((current) => [JSON.parse((event as MessageEvent<string>).data) as T, ...current].slice(0, MAX_ROWS));
  });

  source.addEventListener('heartbeat', () => {
    lastEvent.set(new Date());
    state.set('live');
  });

  // EventSource reconnects by itself, so an error is normally a gap rather than
  // an end; the state reflects that instead of tearing the subscription down.
  //
  // An expired session is the exception: EventSource cannot see the 401, so it
  // would retry against a rejecting endpoint every few seconds forever. The
  // check below is what turns that into a re-login.
  source.addEventListener('error', () => {
    state.set('connecting');

    if (onUnauthorized) {
      void fetch('/api/auth/me', { credentials: 'include' }).then((response) => {
        if (response.status === 401) {
          source.close();
          state.set('closed');
          onUnauthorized();
        }
      });
    }
  });

  return {
    rows: rows.asReadonly(),
    state: state.asReadonly(),
    lastEvent: lastEvent.asReadonly(),
    close: () => {
      source.close();
      state.set('closed');
    },
  };
}
