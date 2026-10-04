import { Routes } from '@angular/router';

import { authGuard } from './core/auth-guard';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'services' },
  {
    path: 'services',
    canActivate: [authGuard],
    title: 'Services · sonde',
    loadComponent: () => import('./features/services-view/services-view').then((m) => m.ServicesView),
  },
  // A trace opens in a panel over the list rather than on a page of its own:
  // reading one is almost always a step in scanning many, and a navigation
  // throws away the search you were in the middle of. It stays a child route
  // so the URL still names the trace - a panel you cannot link to is a worse
  // page, not a better one.
  {
    path: 'traces',
    canActivate: [authGuard],
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
    path: 'metrics',
    canActivate: [authGuard],
    title: 'Metrics · sonde',
    loadComponent: () => import('./features/metrics-view/metrics-view').then((m) => m.MetricsView),
  },
  {
    path: 'map',
    canActivate: [authGuard],
    title: 'Map · sonde',
    loadComponent: () => import('./features/graph-view/graph-view').then((m) => m.GraphView),
  },
  {
    path: 'apps',
    canActivate: [authGuard],
    title: 'Apps & keys · sonde',
    loadComponent: () => import('./features/apps-view/apps-view').then((m) => m.AppsView),
  },
  // The app being looked at belongs in the URL: it can then be linked to, sent
  // to someone, opened in a second tab and found again in history. Same
  // component, because the list is worth keeping on screen beside the keys.
  {
    path: 'apps/:appId',
    canActivate: [authGuard],
    title: 'Apps & keys · sonde',
    loadComponent: () => import('./features/apps-view/apps-view').then((m) => m.AppsView),
  },
  {
    path: 'logs',
    canActivate: [authGuard],
    title: 'Logs · sonde',
    loadComponent: () => import('./features/logs-view/logs-view').then((m) => m.LogsView),
  },
];
