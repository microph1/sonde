import { Routes } from '@angular/router';

import { authGuard } from './core/auth-guard';

/**
 * Every screen lives under the app whose telemetry it is showing.
 *
 * `/:appId/traces` rather than `/traces?app=…`, because the app is not a filter
 * applied to a shared view — it is which data the view is of. Putting it in the
 * path means a link is unambiguous, the scope survives moving between sections,
 * and nothing can be read without having said whose it is.
 *
 * `all` is a real value, not an absent one: telemetry ingested with ingest auth
 * off carries no app at all, which is the normal state of a development stack,
 * and a console that could not show it would be useless there.
 */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'all/services' },

  // Managing apps is not looking at one, so it stays outside the scope.
  {
    path: 'apps',
    canActivate: [authGuard],
    title: 'Apps & keys · sonde',
    loadComponent: () => import('./features/apps-view/apps-view').then((m) => m.AppsView),
  },
  {
    path: 'apps/:appId',
    canActivate: [authGuard],
    title: 'Apps & keys · sonde',
    loadComponent: () => import('./features/apps-view/apps-view').then((m) => m.AppsView),
  },

  {
    path: ':appId',
    canActivate: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'services' },
      {
        path: 'services',
        title: 'Services · sonde',
        loadComponent: () => import('./features/services-view/services-view').then((m) => m.ServicesView),
      },
      // A trace opens in a panel over the list rather than on a page of its
      // own: reading one is almost always a step in scanning many, and a
      // navigation throws away the search you were in the middle of. It stays
      // a child route so the URL still names the trace - a panel you cannot
      // link to is a worse page, not a better one.
      {
        path: 'traces',
        title: 'Traces · sonde',
        loadComponent: () => import('./features/traces-view/traces-view').then((m) => m.TracesView),
        children: [
          {
            path: ':traceId',
            title: 'Trace · sonde',
            loadComponent: () => import('./features/trace-detail/trace-detail').then((m) => m.TraceDetail),
          },
        ],
      },
      {
        path: 'logs',
        title: 'Logs · sonde',
        loadComponent: () => import('./features/logs-view/logs-view').then((m) => m.LogsView),
      },
      {
        path: 'metrics',
        title: 'Metrics · sonde',
        loadComponent: () => import('./features/metrics-view/metrics-view').then((m) => m.MetricsView),
      },
      {
        path: 'map',
        title: 'Map · sonde',
        loadComponent: () => import('./features/graph-view/graph-view').then((m) => m.GraphView),
      },
    ],
  },
];
