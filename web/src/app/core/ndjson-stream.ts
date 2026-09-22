import { Observable } from 'rxjs';

import { readNdjson } from './ndjson';

export class UnauthorizedError extends Error {
  constructor() {
    super('your session expired — signing you in again');
  }
}

/**
 * An NDJSON response as a stream of rows.
 *
 * Unsubscribing aborts the request: a search whose results nobody is waiting
 * for should stop occupying the server, and `switchMap` in the store is what
 * makes that automatic when a new search replaces it.
 */
export function ndjsonRows<T>(request: (signal: AbortSignal) => Promise<Response>): Observable<T> {
  return new Observable<T>((subscriber) => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await request(controller.signal);

        if (response.status === 401) {
          throw new UnauthorizedError();
        }

        if (!response.ok) {
          const detail = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(detail?.error ?? `request failed with ${response.status}`);
        }

        if (!response.body) {
          throw new Error('response had no body');
        }

        for await (const row of readNdjson<T>(response.body)) {
          subscriber.next(row);
        }

        subscriber.complete();
      } catch (cause) {
        // An abort is the caller changing their mind, not a failure to report.
        if (controller.signal.aborted) {
          subscriber.complete();
          return;
        }

        subscriber.error(cause);
      }
    })();

    return () => controller.abort();
  });
}

/**
 * A server-sent event stream as an observable.
 *
 * `EventSource` reconnects on its own, so an error is a gap rather than an end
 * and the stream is not torn down for one. An expired session is the exception:
 * EventSource cannot see the 401, so without the probe it would retry against a
 * rejecting endpoint forever.
 */
export function sseEvents<T>(url: string, eventName = 'row'): Observable<T> {
  return new Observable<T>((subscriber) => {
    const source = new EventSource(url, { withCredentials: true });

    source.addEventListener(eventName, (event) => {
      subscriber.next(JSON.parse((event as MessageEvent<string>).data) as T);
    });

    source.addEventListener('error', () => {
      void fetch('/api/auth/me', { credentials: 'include' }).then((response) => {
        if (response.status === 401) {
          subscriber.error(new UnauthorizedError());
        }
      });
    });

    return () => source.close();
  });
}
