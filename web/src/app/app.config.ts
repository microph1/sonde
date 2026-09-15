import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // `withComponentInputBinding` is what lets TraceDetail declare the route's
    // :traceId as an `input.required()` rather than reading ActivatedRoute.
    provideRouter(routes, withComponentInputBinding()),
  ],
};
