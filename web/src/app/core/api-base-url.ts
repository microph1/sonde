import { InjectionToken } from '@angular/core';

/** Injected rather than imported from an environment file so the same build can
 * be pointed at a different API without rebuilding. */
export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', {
  providedIn: 'root',
  factory: () => '/api',
});
