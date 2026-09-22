import { Injectable, inject, signal } from '@angular/core';

import { API_BASE_URL } from './api-base-url';

export interface CurrentUser {
  readonly sub: string;
  readonly email: string;
  readonly name: string;
}

@Injectable({ providedIn: 'root' })
export class Auth {
  private readonly baseUrl = inject(API_BASE_URL);

  private readonly currentUser = signal<CurrentUser | null>(null);

  readonly user = this.currentUser.asReadonly();

  /** Resolves to whether there is a session. Called by the route guard, so it
   * runs once before the first view rather than on every request. */
  async check(): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/auth/me`, { credentials: 'include' });

    if (!response.ok) {
      this.currentUser.set(null);
      return false;
    }

    this.currentUser.set((await response.json()) as CurrentUser);
    return true;
  }

  /**
   * A full navigation, not a fetch: the identity provider answers with HTML and
   * sets its own cookies, neither of which survives an XHR.
   */
  login(): void {
    window.location.href = `${this.baseUrl}/auth/login`;
  }

  async logout(): Promise<void> {
    await fetch(`${this.baseUrl}/auth/logout`, { method: 'POST', credentials: 'include' });
    this.currentUser.set(null);
    window.location.href = '/';
  }
}
