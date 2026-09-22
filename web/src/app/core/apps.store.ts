import { Injectable, inject } from '@angular/core';
import { Effect, Reduce, Store, makeStore } from '@microphi/store';
import { Observable, from, map, of } from 'rxjs';

import { API_BASE_URL } from './api-base-url';

export interface App {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export type KeyKind = 'secret' | 'public';

export interface ApiKey {
  readonly id: string;
  readonly appId: string;
  readonly kind: KeyKind;
  readonly name: string;
  readonly hint: string;
  readonly origins: string[];
  readonly createdAt: string;
  readonly revoked: number;
}

export interface IssuedKey extends ApiKey {
  readonly secret: string;
}

export interface NewKey {
  readonly appId: string;
  readonly kind: KeyKind;
  readonly name: string;
  readonly origins: string[];
}

export interface AppsState {
  apps: App[];
  keys: ApiKey[];
  /** The secret from the most recent issue, held only so the UI can show it
   * once. It exists nowhere else — not in the database, not in a later
   * response. */
  issued: IssuedKey | null;
}

export interface AppsActions {
  loadApps: () => Observable<App[]>;
  loadKeys: () => Observable<ApiKey[]>;
  createApp: (name: string) => Observable<App>;
  deleteApp: (appId: string) => Observable<string>;
  issueKey: (key: NewKey) => Observable<IssuedKey>;
  revokeKey: (keyId: string) => Observable<string>;
  dismissIssued: () => Observable<void>;
}

@Injectable({ providedIn: 'root' })
export class AppsStore
  extends Store<AppsState, AppsActions>
  implements makeStore<AppsState, AppsActions>
{
  private readonly baseUrl = inject(API_BASE_URL);

  readonly apps$ = this.select((state) => state.apps);
  readonly keys$ = this.select((state) => state.keys);
  readonly issued$ = this.select((state) => state.issued);

  constructor() {
    super({ apps: [], keys: [], issued: null });
  }

  @Effect()
  loadApps(): Observable<App[]> {
    return from(this.request<App[]>('GET', '/apps'));
  }

  @Reduce()
  onLoadApps(state: AppsState, apps: App[]): AppsState {
    return { ...state, apps };
  }

  @Effect()
  loadKeys(): Observable<ApiKey[]> {
    return from(this.request<ApiKey[]>('GET', '/keys'));
  }

  @Reduce()
  onLoadKeys(state: AppsState, keys: ApiKey[]): AppsState {
    return { ...state, keys };
  }

  @Effect()
  createApp(name: string): Observable<App> {
    return from(this.request<App>('POST', '/apps', { name }));
  }

  /** Appended rather than refetched: the server already told us what it made,
   * so a second round trip would only confirm it. */
  @Reduce()
  onCreateApp(state: AppsState, app: App): AppsState {
    return { ...state, apps: [...state.apps, app] };
  }

  @Effect()
  deleteApp(appId: string): Observable<string> {
    return from(this.request<{ deleted: string }>('DELETE', `/apps/${appId}`)).pipe(
      map((response) => response.deleted),
    );
  }

  @Reduce()
  onDeleteApp(state: AppsState, appId: string): AppsState {
    return {
      ...state,
      apps: state.apps.filter((app) => app.id !== appId),
      // Its keys go with it; leaving them listed would invite revoking a key
      // that no longer has anything to authenticate against.
      keys: state.keys.filter((key) => key.appId !== appId),
    };
  }

  @Effect()
  issueKey(key: NewKey): Observable<IssuedKey> {
    return from(this.request<IssuedKey>('POST', '/keys', key));
  }

  @Reduce()
  onIssueKey(state: AppsState, issued: IssuedKey): AppsState {
    return { ...state, keys: [issued, ...state.keys], issued };
  }

  @Effect()
  revokeKey(keyId: string): Observable<string> {
    return from(this.request<{ revoked: string }>('DELETE', `/keys/${keyId}`)).pipe(
      map((response) => response.revoked),
    );
  }

  /** Revoked keys stay listed, marked: knowing a key existed and was revoked is
   * worth more than a shorter table. */
  @Reduce()
  onRevokeKey(state: AppsState, keyId: string): AppsState {
    return {
      ...state,
      keys: state.keys.map((key) => (key.id === keyId ? { ...key, revoked: 1 } : key)),
    };
  }

  @Effect()
  dismissIssued(): Observable<void> {
    return of(undefined);
  }

  @Reduce()
  onDismissIssued(state: AppsState): AppsState {
    return { ...state, issued: null };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(detail?.error ?? `${method} ${path} failed with ${response.status}`);
    }

    return (await response.json()) as T;
  }
}
