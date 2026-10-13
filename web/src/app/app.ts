import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AsyncPipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTabsModule } from '@angular/material/tabs';
import { MatToolbarModule } from '@angular/material/toolbar';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { combineLatest, map } from 'rxjs';

import { AppScope } from './core/app-scope';
import { AppsStore } from './core/apps.store';
import { Auth } from './core/auth';

interface Section {
  readonly path: string;
  readonly label: string;
  readonly icon: string;
}

@Component({
  selector: 'wt-root',
  imports: [
    AsyncPipe,
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
      <a class="brand" [routerLink]="['/', (appId$ | async) ?? 'all', 'services']">son<span>·</span>de</a>

      <!-- Which app the console is showing, not a filter applied to it: every
           section below is of this app, and switching stays on the section you
           are already reading. -->
      <button mat-button class="scope" [matMenuTriggerFor]="scopeMenu">
        <mat-icon>inventory_2</mat-icon>
        {{ (scopeLabel$ | async) ?? 'All apps' }}
        <mat-icon class="caret">arrow_drop_down</mat-icon>
      </button>

      <mat-menu #scopeMenu="matMenu">
        <button mat-menu-item (click)="switchTo('all')">
          <mat-icon>{{ (appId$ | async) === 'all' ? 'check' : 'done_all' }}</mat-icon>
          All apps
        </button>
        @for (app of apps$ | async; track app.id) {
          <button mat-menu-item (click)="switchTo(app.id)">
            <mat-icon>{{ app.id === (appId$ | async) ? 'check' : 'inventory_2' }}</mat-icon>
            {{ app.name }}
          </button>
        }
        <button mat-menu-item routerLink="/apps">
          <mat-icon>key</mat-icon>
          Manage apps &amp; keys
        </button>
      </mat-menu>

      <!-- A tab bar rather than a row of links: the active indicator is the
           thing that says where you are, and Material draws and moves it. -->
      <nav mat-tab-nav-bar [tabPanel]="panel" aria-label="Sections" class="sections">
        @for (section of sections; track section.path) {
          <a
            mat-tab-link
            [routerLink]="['/', (appId$ | async) ?? 'all', section.path]"
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
    .scope {
      --mdc-text-button-label-text-color: var(--text);
    }

    .scope .caret {
      margin-inline-start: calc(var(--fx-3xs) * -1);
      opacity: 0.7;
    }

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
  private readonly scope = inject(AppScope);
  private readonly apps = inject(AppsStore);

  // Relative to the app, because that is what every one of them is of. Apps
  // and keys are managed from the scope menu instead: that page is about the
  // apps themselves, not about one app's telemetry.
  protected readonly sections: Section[] = [
    { path: 'services', label: 'Services', icon: 'lan' },
    { path: 'traces', label: 'Traces', icon: 'account_tree' },
    { path: 'map', label: 'Map', icon: 'hub' },
    { path: 'logs', label: 'Logs', icon: 'subject' },
    { path: 'metrics', label: 'Metrics', icon: 'monitoring' },
  ];

  protected readonly appId$ = this.scope.appId$;
  protected readonly apps$ = this.apps.apps$;

  protected readonly scopeLabel$ = combineLatest([this.scope.appId$, this.apps.apps$]).pipe(
    map(([id, apps]) => (id === 'all' ? 'All apps' : (apps.find((app) => app.id === id)?.name ?? id))),
  );

  protected switchTo(appId: string): void {
    this.scope.switchTo(appId);
  }
}
