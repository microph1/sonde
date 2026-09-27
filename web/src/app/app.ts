import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTabsModule } from '@angular/material/tabs';
import { MatToolbarModule } from '@angular/material/toolbar';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { Auth } from './core/auth';

interface Section {
  readonly path: string;
  readonly label: string;
  readonly icon: string;
}

@Component({
  selector: 'wt-root',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatToolbarModule,
    MatTabsModule,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <mat-toolbar class="shell-header">
      <a class="brand" routerLink="/services">son<span>·</span>de</a>

      <!-- A tab bar rather than a row of links: the active indicator is the
           thing that says where you are, and Material draws and moves it. -->
      <nav mat-tab-nav-bar [tabPanel]="panel" aria-label="Sections" class="sections">
        @for (section of sections; track section.path) {
          <a
            mat-tab-link
            [routerLink]="section.path"
            routerLinkActive
            #link="routerLinkActive"
            [active]="link.isActive"
          >
            <mat-icon>{{ section.icon }}</mat-icon>
            {{ section.label }}
          </a>
        }
      </nav>

      <span class="fx-ml-a"></span>

      @if (auth.user(); as user) {
        <button mat-button [matMenuTriggerFor]="account" class="account">
          <mat-icon>account_circle</mat-icon>
          {{ user.email || user.name }}
        </button>

        <mat-menu #account="matMenu">
          <button mat-menu-item (click)="auth.logout()">
            <mat-icon>logout</mat-icon>
            Sign out
          </button>
        </mat-menu>
      }
    </mat-toolbar>

    <mat-tab-nav-panel #panel>
      <main class="fx-p-5">
        <router-outlet />
      </main>
    </mat-tab-nav-panel>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }

    .shell-header {
      gap: var(--fx-m);
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

    /* Inside a toolbar the bar has to give up the bottom rule it would
       otherwise draw across the whole header. */
    .sections {
      --mat-tab-container-height: 3rem;

      border-bottom: 0;
    }

    .sections mat-icon {
      margin-inline-end: var(--fx-3xs);
      font-size: 1.1rem;
      width: 1.1rem;
      height: 1.1rem;
    }

    .account mat-icon {
      margin-inline-end: var(--fx-3xs);
    }

    main {
      display: block;
    }
  `,
})
export class App {
  protected readonly auth = inject(Auth);

  protected readonly sections: Section[] = [
    { path: '/services', label: 'Services', icon: 'lan' },
    { path: '/traces', label: 'Traces', icon: 'account_tree' },
    { path: '/logs', label: 'Logs', icon: 'subject' },
    { path: '/metrics', label: 'Metrics', icon: 'monitoring' },
    { path: '/apps', label: 'Apps', icon: 'key' },
  ];
}
