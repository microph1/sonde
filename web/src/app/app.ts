import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'wt-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="shell-header">
      <a class="brand" routerLink="/services">the<span>·</span>watchers</a>
      <nav aria-label="Sections">
        <a routerLink="/services" routerLinkActive="active">Services</a>
        <a routerLink="/traces" routerLinkActive="active">Traces</a>
        <a routerLink="/logs" routerLinkActive="active">Logs</a>
      </nav>
    </header>

    <main>
      <router-outlet />
    </main>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }

    .shell-header {
      display: flex;
      align-items: center;
      gap: 2rem;
      padding: 0.75rem 1.5rem;
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

    nav {
      display: flex;
      gap: 0.25rem;
    }

    nav a {
      padding: 0.35rem 0.75rem;
      border-radius: 6px;
      color: var(--text-dim);
      text-decoration: none;
    }

    nav a:hover {
      color: var(--text);
      background: var(--surface-raised);
    }

    nav a.active {
      color: var(--text);
      background: var(--surface-raised);
    }

    main {
      flex: 1;
      padding: 1.5rem;
    }
  `,
})
export class App {}
