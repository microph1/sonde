import { Injectable, inject } from '@angular/core';
import { Effect, Reduce, Store, makeStore } from '@microphi/store';
import { Observable, from, of } from 'rxjs';

import { API_BASE_URL } from './api-base-url';
import { DEFAULT_RANGE, Range } from './services.store';

export interface GraphNode {
  readonly id: string;
  readonly spans: number;
  readonly errors: number;
}

export interface GraphEdge {
  readonly source: string;
  readonly target: string;
  readonly calls: number;
  readonly errors: number;
  readonly p95Ms: number;
  readonly kinds: string;
}

export interface ServiceGraph {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
  /** Spans whose parent never arrived: the start of a trace, or a hop nobody
   * instrumented. */
  readonly entries: GraphEdge[];
}

export interface GraphState {
  graph: ServiceGraph;
  range: Range;
  group: string;
}

export interface GraphActions {
  load: () => Observable<ServiceGraph>;
  selectRange: (range: Range) => Observable<Range>;
  selectGrouping: (group: string) => Observable<string>;
}

const EMPTY: ServiceGraph = { nodes: [], edges: [], entries: [] };

@Injectable({ providedIn: 'root' })
export class GraphStore
  extends Store<GraphState, GraphActions>
  implements makeStore<GraphState, GraphActions>
{
  private readonly baseUrl = inject(API_BASE_URL);

  readonly graph$ = this.select((state) => state.graph);
  readonly range$ = this.select((state) => state.range);
  readonly group$ = this.select((state) => state.group);

  constructor() {
    super({ graph: EMPTY, range: DEFAULT_RANGE, group: 'service' });
  }

  @Effect()
  load(): Observable<ServiceGraph> {
    const { range, group } = this.snapshot();

    return from(
      this.request<ServiceGraph>({
        from: new Date(Date.now() - range.windowMinutes * 60_000).toISOString(),
        group,
      }),
    );
  }

  @Reduce()
  onLoad(state: GraphState, graph: ServiceGraph): GraphState {
    return { ...state, graph };
  }

  @Effect()
  selectRange(range: Range): Observable<Range> {
    return of(range);
  }

  /** The reload is dispatched from the reducer's caller rather than chained
   * here, so the new window is in state before the request reads it. */
  @Reduce()
  onSelectRange(state: GraphState, range: Range): GraphState {
    return { ...state, range };
  }

  @Effect()
  selectGrouping(group: string): Observable<string> {
    return of(group);
  }

  @Reduce()
  onSelectGrouping(state: GraphState, group: string): GraphState {
    return { ...state, group };
  }

  private snapshot(): GraphState {
    return this._store$.getValue();
  }

  private async request<T>(body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}/services/graph`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(detail?.error ?? `the graph query failed with ${response.status}`);
    }

    return (await response.json()) as T;
  }
}
