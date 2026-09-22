import { Routes } from '@angular/router';

import { authGuard } from './core/auth-guard';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'services' },
  {
    path: 'services',
    canActivate: [authGuard],
    title: 'Services · the-watchers',
    loadComponent: () => import('./features/services-view/services-view').then((m) => m.ServicesView),
  },
  {
    path: 'traces',
    canActivate: [authGuard],
    title: 'Traces · the-watchers',
    loadComponent: () => import('./features/traces-view/traces-view').then((m) => m.TracesView),
  },
  {
    path: 'traces/:traceId',
    canActivate: [authGuard],
    title: 'Trace · the-watchers',
    loadComponent: () => import('./features/trace-detail/trace-detail').then((m) => m.TraceDetail),
  },
  {
    path: 'apps',
    canActivate: [authGuard],
    title: 'Apps & keys · the-watchers',
    loadComponent: () => import('./features/apps-view/apps-view').then((m) => m.AppsView),
  },
  {
    path: 'logs',
    canActivate: [authGuard],
    title: 'Logs · the-watchers',
    loadComponent: () => import('./features/logs-view/logs-view').then((m) => m.LogsView),
  },
];
