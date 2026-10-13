import { Injectable, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { Observable, combineLatest, distinctUntilChanged, filter, map, startWith } from 'rxjs';

import { AppsStore } from './apps.store';

/** The path segment that means "everything, including what carries no app". */
export const ALL_APPS = 'all';

/**
 * Which app's telemetry the console is showing.
 *
 * The URL holds the app's id, because that is what identifies an app
 * everywhere else in this console and it survives a rename. The queries need
 * its name, because that is what the receiver stamps onto `sonde.app` — it
 * writes the name the key belonged to at ingest time, which is also why a
 * rename does not rewrite history.
 *
 * So this is the one place that translates, and it is deliberately pessimistic:
 * an id it cannot resolve yet resolves to itself, which matches no stamped name
 * and therefore shows nothing. Showing nothing while the app list loads is
 * recoverable; showing another app's traces for half a second is not.
 */
@Injectable({ providedIn: 'root' })
export class AppScope {
  private readonly router = inject(Router);
  private readonly apps = inject(AppsStore);

  /** The `:appId` segment as it appears in the URL. */
  readonly appId$: Observable<string> = this.router.events.pipe(
    filter((event) => event instanceof NavigationEnd),
    startWith(null),
    map(() => this.idFromUrl()),
    distinctUntilChanged(),
  );

  /**
   * The value to filter telemetry by: the app's stamped name, or an empty
   * string for every app.
   */
  readonly app$: Observable<string> = combineLatest([this.appId$, this.apps.apps$]).pipe(
    map(([id, apps]) => resolve(id, apps)),
    distinctUntilChanged(),
  );

  constructor() {
    // The scope cannot be resolved without the list, and every page depends on
    // the scope, so asking for it is this service's job rather than a thing
    // each page has to remember.
    this.apps.dispatch('loadApps');
  }

  /** The same value, read at the moment a request is built. */
  get current(): string {
    return resolve(this.idFromUrl(), this.apps.snapshot().apps);
  }

  get currentId(): string {
    return this.idFromUrl();
  }

  /** The same page, under a different app. */
  switchTo(appId: string): void {
    const rest = this.router.url.split('/').slice(2).join('/');

    this.router.navigateByUrl(`/${appId}/${rest || 'services'}`);
  }

  private idFromUrl(): string {
    // The first segment, minus any query string: routing guarantees it, except
    // on /apps which has no scope at all.
    const first = this.router.url.split('?')[0].split('/').filter(Boolean)[0] ?? ALL_APPS;

    return first === 'apps' ? ALL_APPS : first;
  }
}

function resolve(appId: string, apps: readonly { id: string; name: string }[]): string {
  if (appId === ALL_APPS) {
    return '';
  }

  return apps.find((app) => app.id === appId)?.name ?? appId;
}
