import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { MAT_FORM_FIELD_DEFAULT_OPTIONS } from '@angular/material/form-field';
import { MAT_ICON_DEFAULT_OPTIONS } from '@angular/material/icon';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // No animations provider: Material 21 animates in CSS, so @angular/animations
    // is not a dependency of this app and does not need to be one.
    //
    // The icon font ships with the bundle instead of being fetched from Google,
    // so the console still works on a machine that cannot reach the internet —
    // a reasonable thing for a monitoring tool to survive.
    { provide: MAT_ICON_DEFAULT_OPTIONS, useValue: { fontSet: 'material-symbols-rounded' } },
    // Outlined fields rather than filled: on a dark surface a filled field is a
    // solid block that reads as a disabled control, and these sit next to
    // tables and charts that are already carrying most of the page's weight.
    { provide: MAT_FORM_FIELD_DEFAULT_OPTIONS, useValue: { appearance: 'outline' } },
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
