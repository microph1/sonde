import { inject } from '@angular/core';
import { CanActivateFn } from '@angular/router';

import { Auth } from './auth';

/**
 * Sends anyone without a session to the identity provider.
 *
 * Returning `false` rather than a redirect to an in-app login route: there is
 * no in-app login page — the provider owns that screen, and the API owns the
 * redirect that starts the flow.
 */
export const authGuard: CanActivateFn = async () => {
  const auth = inject(Auth);

  if (auth.user()) {
    return true;
  }

  if (await auth.check()) {
    return true;
  }

  auth.login();
  return false;
};
