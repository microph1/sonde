import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { Auth } from './core/auth';

@Component({
  selector: 'wt-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="shell-header fx-flex fx-items-center fx-gap-6 fx-px-5 fx-py-3">
      <a class="brand" routerLink="/services">son<span>·</span>de</a>

      <nav class="fx-flex fx-gap-1" aria-label="Sections">
        <a routerLink="/services" routerLinkActive="active">Services</a>
        <a routerLink="/traces" routerLinkActive="active">Traces</a>
        <a routerLink="/logs" routerLinkActive="active">Logs</a>
        <a routerLink="/apps" routerLinkActive="active">Apps</a>
      </nav>

      @if (auth.user(); as user) {
        <div class="account fx-flex fx-items-center fx-gap-3 fx-ml-a">
          <span class="dim">{{ user.email || user.name }}</span>
          <button type="button" (click)="auth.logout()">Sign out</button>
        </div>
      }
    </header>

    <main class="fx-flex-grow-1 fx-p-5">
      <router-outlet />
    </main>
  `,
  styles: `
    /* Only what the utilities do not express: colour, borders and the two
       bespoke shapes in the header. Layout lives in the template. */
    :host {
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }

    .shell-header {
      border-bottom: 1px solid var(--line);
      background: var(--surface);
    }

    .brand {
      font-weight: 600;
      letter-spacing: 0.02em;
      color: var(--text);
      text-decoration: none;
    }

    .brand span {
      color: var(--accent);
    }

    nav a {
      padding: var(--fx-3xs) var(--fx-2xs);
      border-radius: 6px;
      color: var(--text-dim);
      text-decoration: none;
    }

    nav a:hover,
    nav a.active {
      color: var(--text);
      background: var(--surface-raised);
    }
  `,
})
export class App {
  protected readonly auth = inject(Auth);
}
