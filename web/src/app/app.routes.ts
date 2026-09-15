import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'services' },
  {
    path: 'services',
    title: 'Services · the-watchers',
    loadComponent: () => import('./features/services-view/services-view').then((m) => m.ServicesView),
  },
  {
    path: 'traces',
    title: 'Traces · the-watchers',
    loadComponent: () => import('./features/traces-view/traces-view').then((m) => m.TracesView),
  },
  {
    path: 'traces/:traceId',
    title: 'Trace · the-watchers',
    loadComponent: () => import('./features/trace-detail/trace-detail').then((m) => m.TraceDetail),
  },
  {
    path: 'logs',
    title: 'Logs · the-watchers',
    loadComponent: () => import('./features/logs-view/logs-view').then((m) => m.LogsView),
  },
];
