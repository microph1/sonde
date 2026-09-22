import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // `withComponentInputBinding` is what lets TraceDetail declare the route's
    // :traceId as an `input.required()` rather than reading ActivatedRoute.
    provideRouter(
      routes,
      withComponentInputBinding(),
      // So a tile linking to `#services` actually moves the page to the table it
      // counts, rather than only changing the URL.
      withInMemoryScrolling({ anchorScrolling: 'enabled', scrollPositionRestoration: 'enabled' }),
    ),
  ],
};
