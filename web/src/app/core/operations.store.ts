import { Injectable, inject } from '@angular/core';
import { Effect, Reduce, Store, makeStore } from '@microphi/store';
import { Observable, from, of } from 'rxjs';

import { API_BASE_URL } from './api-base-url';
import { AppScope } from './app-scope';
import { DEFAULT_RANGE, Range } from './services.store';

/** One row of rate, errors and duration. `SpanName` is empty when the row is a
 * whole service rather than one of its operations. */
export interface OperationStats {
  readonly ServiceName: string;
  readonly SpanName: string;
  readonly calls: number;
  readonly errors: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly kinds: string;
}

export type OperationSort = 'calls' | 'errors' | 'p50' | 'p95' | 'p99' | 'max';

export interface OperationQuery {
  readonly by: 'service' | 'operation';
  readonly service: string;
  readonly kind: string;
  readonly sort: OperationSort;
  readonly range: Range;
}

export interface OperationsState {
  rows: OperationStats[];
  query: OperationQuery;
}

export interface OperationsActions {
  load: (query: Partial<OperationQuery>) => Observable<OperationStats[]>;
  apply: (query: Partial<OperationQuery>) => Observable<Partial<OperationQuery>>;
}

export const DEFAULT_QUERY: OperationQuery = {
  by: 'operation',
  service: '',
  kind: '',
  sort: 'calls',
  range: DEFAULT_RANGE,
};

/**
 * Rate, errors and duration per operation.
 *
 * A separate store from the overview's: the overview is one chart of volume
 * over a window and this is a ranking at a point in time, and they reload for
 * different reasons.
 */
@Injectable({ providedIn: 'root' })
export class OperationsStore
  extends Store<OperationsState, OperationsActions>
  implements makeStore<OperationsState, OperationsActions>
{
  private readonly baseUrl = inject(API_BASE_URL);
  /** Every query is of one app's telemetry; the scope says which. */
  private readonly scope = inject(AppScope);

  readonly rows$ = this.select((state) => state.rows);
  readonly query$ = this.select((state) => state.query);

  constructor() {
    super({ rows: [], query: DEFAULT_QUERY });
  }

  /**
   * The query is merged into state before the request is built, so a caller
   * can change one field — the sort, say — without restating the rest, and
   * what came back is always what the controls say.
   */
  @Effect()
  load(changes: Partial<OperationQuery> = {}): Observable<OperationStats[]> {
    const query = { ...this.snapshot().query, ...changes };

    return from(
      this.request<OperationStats[]>({
        app: this.scope.current,
        by: query.by,
        service: query.service,
        kind: query.kind,
        sort: query.sort,
        from: new Date(Date.now() - query.range.windowMinutes * 60_000).toISOString(),
        limit: 200,
      }),
    );
  }

  @Reduce()
  onLoad(state: OperationsState, rows: OperationStats[]): OperationsState {
    return { ...state, rows };
  }

  @Effect()
  apply(changes: Partial<OperationQuery>): Observable<Partial<OperationQuery>> {
    return of(changes);
  }

  @Reduce()
  onApply(state: OperationsState, changes: Partial<OperationQuery>): OperationsState {
    return { ...state, query: { ...state.query, ...changes } };
  }

  private snapshot(): OperationsState {
    return this._store$.getValue();
  }

  private async request<T>(body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}/operations`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(detail?.error ?? `the operations query failed with ${response.status}`);
    }

    return (await response.json()) as T;
  }
}
