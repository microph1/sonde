import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AsyncPipe, DatePipe } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';
import { MatTooltipModule } from '@angular/material/tooltip';
import { BehaviorSubject, combineLatest, filter, map, startWith } from 'rxjs';

import { ApiKey, App, AppsStore, KeyKind } from '../../core/apps.store';
import { CopyButton } from '../../shared/copy-button';
import { IssuedKeyDialog } from './issued-key.dialog';

interface AppCard extends App {
  readonly keys: ApiKey[];
  readonly live: number;
  readonly revoked: number;
}

@Component({
  selector: 'wt-apps-view',
  imports: [
    ReactiveFormsModule,
    AsyncPipe,
    DatePipe,
    CopyButton,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatRadioModule,
    MatTooltipModule,
    MatDialogModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="fx-flex fx-flex-wrap fx-items-start fx-gap-4 fx-mb-5">
      <div class="intro">
        <h1>Apps &amp; keys</h1>
        <p class="dim">
          An app is what a key identifies. The receiver stamps every batch with the app its
          key belongs to, which is why that grouping can be trusted where
          <code>service.name</code> cannot — anything can claim to be any service, but only
          a key holder can claim to be an app.
        </p>
      </div>

      <form [formGroup]="appForm" (ngSubmit)="createApp()" class="new-app fx-flex fx-gap-2 fx-ml-a">
        <mat-form-field subscriptSizing="dynamic">
          <mat-label>New app</mat-label>
          <input matInput formControlName="name" placeholder="microgamma" />
        </mat-form-field>

        <button mat-flat-button type="submit" [disabled]="appForm.invalid">
          <mat-icon>add</mat-icon>
          Create app
        </button>
      </form>
    </header>

    <section class="cards">
      @for (app of cards$ | async; track app.id) {
        <mat-card appearance="outlined">
          <mat-card-header>
            <mat-card-title class="mono">{{ app.name }}</mat-card-title>
            <mat-card-subtitle>
              {{ app.live }} live {{ app.live === 1 ? 'key' : 'keys' }}<!--
              -->{{ app.revoked ? ' · ' + app.revoked + ' revoked' : '' }} · created
              {{ app.createdAt | date: 'MMM d, y' }}
            </mat-card-subtitle>

            <span class="fx-ml-a">
              @if ((confirming$ | async) === app.id) {
                <span class="fx-flex fx-items-center fx-gap-2">
                  <span class="dim">Delete {{ app.name }}?</span>
                  <button mat-flat-button class="danger" (click)="deleteApp(app)">Delete</button>
                  <button mat-button (click)="cancel()">Cancel</button>
                </span>
              } @else {
                <button
                  mat-icon-button
                  matTooltip="Delete this app and its keys"
                  aria-label="Delete this app"
                  (click)="ask(app.id)"
                >
                  <mat-icon>delete</mat-icon>
                </button>
              }
            </span>
          </mat-card-header>

          <ul class="keys">
            @for (key of app.keys; track key.id) {
              <li class="key" [class.revoked]="key.revoked">
                <code class="hint">{{ key.hint }}</code>

                <span class="badge" [class.public]="key.kind === 'public'">{{ key.kind }}</span>

                <span class="what">
                  {{ key.name }}
                  @if (key.origins.length) {
                    <span class="origins dim mono">{{ key.origins.join(' · ') }}</span>
                  } @else if (key.kind === 'public') {
                    <span class="origins warn">any origin</span>
                  }
                </span>

                <time class="dim" [attr.datetime]="key.createdAt">
                  {{ key.createdAt | date: 'MMM d' }}
                </time>

                <span class="actions fx-flex fx-items-center">
                  <wt-copy
                    [value]="key.hint"
                    label="Copy the key prefix"
                    title="Copy the prefix. The key itself was shown once, at issue — only its hash is stored."
                  />

                  @if (key.revoked) {
                    <span class="dim revoked-label">revoked</span>
                  } @else if ((confirming$ | async) === key.id) {
                    <button mat-flat-button class="danger" (click)="revoke(key.id)">Revoke</button>
                    <button mat-button (click)="cancel()">Cancel</button>
                  } @else {
                    <button
                      mat-icon-button
                      matTooltip="Revoke this key"
                      aria-label="Revoke this key"
                      (click)="ask(key.id)"
                    >
                      <mat-icon>block</mat-icon>
                    </button>
                  }
                </span>
              </li>
            } @empty {
              <li class="none dim">No keys yet — this app cannot send anything until one is issued.</li>
            }
          </ul>

          <mat-card-actions>
            @if ((issuingFor$ | async) === app.id) {
              <form [formGroup]="keyForm" (ngSubmit)="issueKey()" class="issue">
                <mat-form-field subscriptSizing="dynamic">
                  <mat-label>Name</mat-label>
                  <input matInput formControlName="name" placeholder="relay" />
                </mat-form-field>

                <mat-radio-group formControlName="kind" aria-label="Kind" class="kinds">
                  <mat-radio-button value="secret">secret <small class="dim">backends</small></mat-radio-button>
                  <mat-radio-button value="public">public <small class="dim">browsers</small></mat-radio-button>
                </mat-radio-group>

                @if ((kind$ | async) === 'public') {
                  <mat-form-field class="origins-field" subscriptSizing="dynamic">
                    <mat-label>Allowed origins</mat-label>
                    <input matInput formControlName="origins" placeholder="http://app.localhost, https://app.example" />
                    <mat-hint>
                      A public key ships to browsers, so anyone who opens devtools can read it.
                      Comma separated. Left empty, the key is accepted from anywhere.
                    </mat-hint>
                  </mat-form-field>
                }

                <span class="fx-flex fx-gap-2 fx-items-center">
                  <button mat-flat-button type="submit" [disabled]="keyForm.invalid">Issue key</button>
                  <button mat-button type="button" (click)="cancelIssue()">Cancel</button>
                </span>
              </form>
            } @else {
              <button mat-button (click)="startIssue(app)">
                <mat-icon>add</mat-icon>
                Issue a key
              </button>
            }
          </mat-card-actions>
        </mat-card>
      } @empty {
        <mat-card appearance="outlined">
          <mat-card-content class="dim">
            No apps yet. Telemetry can still arrive while ingest auth is off; name an app above
            to start requiring a key.
          </mat-card-content>
        </mat-card>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
      max-width: 72rem;
    }

    .intro {
      max-width: 62ch;
    }

    .intro p {
      margin: 0;
    }

    .new-app mat-form-field {
      min-width: 14rem;
    }

    .cards {
      display: grid;
      gap: var(--fx-s);
    }

    mat-card-header {
      align-items: center;
      gap: var(--fx-2xs);
    }

    mat-card-title.mono {
      font-size: var(--fx-typography-1);
    }

    /* One grid for the whole list so every row lines up, rather than each row
       sizing its own columns. */
    .keys {
      display: grid;
      grid-template-columns: max-content max-content 1fr max-content max-content;
      margin: 0;
      padding: 0;
      list-style: none;
      border-top: 1px solid var(--mat-sys-outline-variant);
    }

    .key {
      display: grid;
      grid-column: 1 / -1;
      grid-template-columns: subgrid;
      align-items: center;
      gap: var(--fx-xs);
      padding: var(--fx-3xs) var(--fx-s);
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }

    .key:hover {
      background: var(--surface-raised);
    }

    .what {
      display: flex;
      flex-direction: column;
      line-height: 1.3;
      min-width: 0;
    }

    .origins {
      font-size: var(--fx-typography--2);
    }

    .origins.warn {
      color: var(--warn);
    }

    .badge {
      padding: 0.05rem 0.45rem;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 999px;
      background: var(--bg);
      color: var(--text-dim);
      font-size: var(--fx-typography--2);
    }

    .badge.public {
      border-color: color-mix(in srgb, var(--warn) 50%, transparent);
      color: var(--warn);
    }

    time {
      font-size: var(--fx-typography--1);
      white-space: nowrap;
    }

    /* Revoked rows stay legible: dimmed, not struck through. A line through a
       key prefix reads as a rendering fault at a glance. */
    .key.revoked .hint,
    .key.revoked .what,
    .key.revoked .badge {
      opacity: 0.45;
    }

    .revoked-label {
      padding-inline: var(--fx-2xs);
      font-size: var(--fx-typography--1);
    }

    .none {
      padding: var(--fx-2xs) var(--fx-s);
      grid-column: 1 / -1;
    }

    .issue {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--fx-s);
      width: 100%;
    }

    .origins-field {
      flex: 1 1 24rem;
    }

    .kinds {
      display: flex;
      gap: var(--fx-2xs);
    }

    /* Destructive actions are quiet until asked for, and unmistakable once the
       question is on screen. */
    .danger {
      --mdc-filled-button-container-color: color-mix(in srgb, var(--error) 22%, transparent);
      --mdc-filled-button-label-text-color: var(--error);
    }
  `,
})
export class AppsView implements OnInit {
  private readonly store = inject(AppsStore);
  private readonly dialog = inject(MatDialog);
  private readonly destroyRef = inject(DestroyRef);

  /** Keys live inside the app they authenticate, because that is the only
   * relationship either list has. Flat and side by side, reading one meant
   * matching a name in a column against a name in another table. */
  protected readonly cards$ = combineLatest([this.store.apps$, this.store.keys$]).pipe(
    map(([apps, keys]) =>
      apps.map<AppCard>((app) => {
        const mine = keys.filter((key) => key.appId === app.id);

        return {
          ...app,
          keys: [...mine].sort((a, b) => a.revoked - b.revoked || b.createdAt.localeCompare(a.createdAt)),
          live: mine.filter((key) => !key.revoked).length,
          revoked: mine.filter((key) => key.revoked).length,
        };
      }),
    ),
  );

  /** Which card has its issue form open, and which row asked "are you sure?".
   * View state with no meaning outside this page, so it stays here rather than
   * in the store. */
  private readonly issuingFor$$ = new BehaviorSubject<string | null>(null);
  private readonly confirming$$ = new BehaviorSubject<string | null>(null);

  protected readonly issuingFor$ = this.issuingFor$$.asObservable();
  protected readonly confirming$ = this.confirming$$.asObservable();

  protected readonly appForm = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });

  protected readonly keyForm = new FormGroup({
    appId: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    kind: new FormControl<KeyKind>('secret', { nonNullable: true }),
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    origins: new FormControl('', { nonNullable: true }),
  });

  protected readonly kind$ = this.keyForm.controls.kind.valueChanges.pipe(
    startWith(this.keyForm.controls.kind.value),
  );

  constructor() {
    // The secret exists for one render and nowhere else, so it takes over the
    // screen rather than appearing somewhere the page may not be scrolled to.
    this.store.issued$
      .pipe(filter(Boolean), takeUntilDestroyed(this.destroyRef))
      .subscribe((issued) => {
        this.dialog
          .open(IssuedKeyDialog, { data: issued, width: '44rem', maxWidth: '92vw' })
          .afterClosed()
          .subscribe(() => this.store.dispatch('dismissIssued'));
      });
  }

  ngOnInit(): void {
    this.store.dispatch('loadApps');
    this.store.dispatch('loadKeys');
  }

  protected createApp(): void {
    this.store.dispatch('createApp', this.appForm.getRawValue().name);
    this.appForm.reset();
  }

  protected startIssue(app: App): void {
    this.keyForm.reset({ appId: app.id, kind: 'secret', name: '', origins: '' });
    this.issuingFor$$.next(app.id);
  }

  protected cancelIssue(): void {
    this.issuingFor$$.next(null);
  }

  protected issueKey(): void {
    const { appId, kind, name, origins } = this.keyForm.getRawValue();

    this.store.dispatch('issueKey', {
      appId,
      kind,
      name,
      origins: origins
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    });

    this.issuingFor$$.next(null);
  }

  /** Deleting an app takes its keys with it and revoking cannot be undone, so
   * both ask first — in place, rather than through a dialog that would land on
   * top of the row it is asking about. */
  protected ask(id: string): void {
    this.confirming$$.next(id);
  }

  protected cancel(): void {
    this.confirming$$.next(null);
  }

  protected deleteApp(app: App): void {
    this.store.dispatch('deleteApp', app.id);
    this.confirming$$.next(null);
  }

  protected revoke(keyId: string): void {
    this.store.dispatch('revokeKey', keyId);
    this.confirming$$.next(null);
  }
}
