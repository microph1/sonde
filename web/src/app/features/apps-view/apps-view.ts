import { ChangeDetectionStrategy, Component, ElementRef, OnInit, ViewChild, inject } from '@angular/core';
import { AsyncPipe, DatePipe } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { BehaviorSubject, combineLatest, map, startWith } from 'rxjs';

import { ApiKey, App, AppsStore, KeyKind } from '../../core/apps.store';
import { CopyButton } from '../../shared/copy-button';

interface AppCard extends App {
  readonly keys: ApiKey[];
  readonly live: number;
  readonly revoked: number;
}

@Component({
  selector: 'wt-apps-view',
  imports: [ReactiveFormsModule, AsyncPipe, DatePipe, CopyButton],
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
        <input formControlName="name" placeholder="New app name" aria-label="New app name" />
        <button type="submit" [disabled]="appForm.invalid">Create app</button>
      </form>
    </header>

    @if (issued$ | async; as issued) {
      <div class="overlay" (click)="close()">
        <aside
          #panel
          class="issued fx-p-4"
          role="dialog"
          aria-modal="true"
          tabindex="-1"
          [attr.aria-label]="issued.name + ' issued'"
          (click)="$event.stopPropagation()"
          (keydown.escape)="close()"
        >
          <div class="fx-flex fx-items-baseline fx-gap-2 fx-flex-wrap">
            <strong>{{ issued.name }} issued.</strong>
            <span class="dim">
              Copy it now — sonde keeps only a hash, so this is the last time anyone can read it.
            </span>
          </div>

          <div class="secret fx-flex fx-items-center fx-gap-2 fx-my-3">
            <code>{{ issued.secret }}</code>
            <wt-copy [value]="issued.secret" label="Copy the key" text="Copy" />
          </div>

          <dl class="snippets">
            <div>
              <dt class="dim">Header</dt>
              <dd>
                <code>Authorization: Bearer {{ issued.secret }}</code>
                <wt-copy [value]="header(issued.secret)" label="Copy the Authorization header" />
              </dd>
            </div>
            <div>
              <dt class="dim">Env</dt>
              <dd>
                <code>OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20{{ issued.secret }}</code>
                <wt-copy [value]="env(issued.secret)" label="Copy the exporter environment variable" />
              </dd>
            </div>
          </dl>

          <button type="button" class="fx-mt-3" (click)="close()">Done</button>
        </aside>
      </div>
    }

    <section class="cards">
      @for (app of cards$ | async; track app.id) {
        <article class="card">
          <header class="fx-flex fx-items-baseline fx-flex-wrap fx-gap-2 fx-p-3">
            <h2 class="mono">{{ app.name }}</h2>
            <span class="dim">
              {{ app.live }} live {{ app.live === 1 ? 'key' : 'keys' }}<!--
              -->{{ app.revoked ? ' · ' + app.revoked + ' revoked' : '' }} · created
              {{ app.createdAt | date: 'MMM d, y' }}
            </span>

            <span class="fx-ml-a">
              @if ((confirming$ | async) === app.id) {
                <span class="fx-flex fx-items-center fx-gap-2">
                  <span class="dim">Delete {{ app.name }}?</span>
                  <button type="button" class="danger" (click)="deleteApp(app)">Delete</button>
                  <button type="button" class="ghost" (click)="cancel()">Cancel</button>
                </span>
              } @else {
                <button type="button" class="ghost" (click)="ask(app.id)">Delete</button>
              }
            </span>
          </header>

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

                <span class="actions fx-flex fx-items-center fx-gap-1">
                  <wt-copy
                    [value]="key.hint"
                    label="Copy the key prefix"
                    title="Copy the prefix. The key itself was shown once, at issue — only its hash is stored."
                  />

                  @if (key.revoked) {
                    <span class="dim">revoked</span>
                  } @else if ((confirming$ | async) === key.id) {
                    <button type="button" class="danger" (click)="revoke(key.id)">Revoke</button>
                    <button type="button" class="ghost" (click)="cancel()">Cancel</button>
                  } @else {
                    <button type="button" class="ghost" (click)="ask(key.id)">Revoke</button>
                  }
                </span>
              </li>
            } @empty {
              <li class="none dim">No keys yet — this app cannot send anything until one is issued.</li>
            }
          </ul>

          @if ((issuingFor$ | async) === app.id) {
            <form [formGroup]="keyForm" (ngSubmit)="issueKey()" class="issue fx-p-3">
              <label>
                Name
                <input formControlName="name" placeholder="relay" />
              </label>

              <fieldset class="kinds">
                <legend>Kind</legend>
                <label class="choice">
                  <input type="radio" formControlName="kind" value="secret" />
                  <span>secret <small class="dim">backends</small></span>
                </label>
                <label class="choice">
                  <input type="radio" formControlName="kind" value="public" />
                  <span>public <small class="dim">browsers</small></span>
                </label>
              </fieldset>

              @if ((kind$ | async) === 'public') {
                <label class="origins-field">
                  Allowed origins
                  <input
                    formControlName="origins"
                    placeholder="http://app.localhost, https://app.example"
                    aria-describedby="origins-help"
                  />
                  <small id="origins-help" class="dim">
                    A public key ships to browsers, so anyone who opens devtools can read it.
                    Origins are what make it useful anyway — comma separated. Left empty, the
                    key is accepted from anywhere.
                  </small>
                </label>
              }

              <div class="fx-flex fx-gap-2 fx-items-center">
                <button type="submit" [disabled]="keyForm.invalid">Issue key</button>
                <button type="button" class="ghost" (click)="cancelIssue()">Cancel</button>
              </div>
            </form>
          } @else {
            <button type="button" class="add" (click)="startIssue(app)">Issue a key</button>
          }
        </article>
      } @empty {
        <p class="none dim fx-p-4">
          No apps yet. Telemetry can still arrive while ingest auth is off; name an app above
          to start requiring a key.
        </p>
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

    .new-app input {
      min-width: 12rem;
    }

    h2 {
      margin: 0;
      font-size: var(--fx-typography-1);
      font-weight: 600;
    }

    .cards {
      display: grid;
      gap: var(--fx-s);
    }

    .card {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--surface);
      overflow: hidden;
    }

    .card > header {
      border-bottom: 1px solid var(--line);
    }

    /* One grid for the whole list so every row lines up, rather than each row
       sizing its own columns. */
    .keys {
      display: grid;
      grid-template-columns: max-content max-content 1fr max-content max-content;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .key {
      display: grid;
      grid-column: 1 / -1;
      grid-template-columns: subgrid;
      align-items: center;
      gap: var(--fx-xs);
      padding: var(--fx-2xs) var(--fx-s);
      border-bottom: 1px solid var(--line);
    }

    .key:hover {
      background: var(--surface-raised);
    }

    .hint {
      color: var(--text);
    }

    .what {
      display: flex;
      flex-direction: column;
      line-height: 1.3;
    }

    .origins {
      font-size: var(--fx-typography--2);
    }

    .origins.warn {
      color: var(--warn);
    }

    .badge {
      padding: 0.05rem 0.45rem;
      border: 1px solid var(--line);
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

    .none {
      padding: var(--fx-2xs) var(--fx-s);
      grid-column: 1 / -1;
    }

    .add {
      width: 100%;
      border: 0;
      border-radius: 0;
      background: transparent;
      color: var(--accent);
      text-align: left;
      padding: var(--fx-2xs) var(--fx-s);
    }

    .add:hover {
      background: var(--surface-raised);
    }

    /* Quiet by default, loud on intent: a destructive action should not be the
       most prominent thing in a row it happens to share with four facts. */
    button.ghost {
      border-color: transparent;
      background: transparent;
      color: var(--text-dim);
    }

    button.ghost:hover:not(:disabled) {
      border-color: var(--line);
      color: var(--text);
    }

    button.danger {
      border-color: color-mix(in srgb, var(--error) 60%, transparent);
      background: color-mix(in srgb, var(--error) 15%, transparent);
      color: var(--error);
    }

    button.danger:hover:not(:disabled) {
      border-color: var(--error);
    }

    .issue {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: var(--fx-s);
      background: var(--surface-raised);
    }

    .issue label {
      display: flex;
      flex-direction: column;
      gap: var(--fx-3xs);
      color: var(--text-dim);
      font-size: var(--fx-typography--1);
    }

    .origins-field {
      flex: 1 1 24rem;
    }

    .origins-field small {
      max-width: 60ch;
      font-size: var(--fx-typography--2);
    }

    .kinds {
      display: flex;
      gap: var(--fx-2xs);
      margin: 0;
      padding: 0;
      border: 0;
    }

    .kinds legend {
      padding: 0;
      color: var(--text-dim);
      font-size: var(--fx-typography--1);
    }

    .choice {
      flex-direction: row !important;
      align-items: center;
      gap: var(--fx-3xs) !important;
      padding: var(--fx-3xs) var(--fx-2xs);
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface);
      cursor: pointer;
    }

    .choice:has(input:checked) {
      border-color: var(--accent);
      color: var(--text);
    }

    /* The one-time secret takes over the screen, because it is the one moment
       on this page that cannot be repeated: issuing from the last card used to
       scroll a banner in at the top, out of sight, and the key was gone. */
    .overlay {
      position: fixed;
      inset: 0;
      z-index: 10;
      display: grid;
      place-items: center;
      padding: var(--fx-s);
      background: color-mix(in srgb, #000 65%, transparent);
    }

    .issued {
      width: min(48rem, 100%);
      border: 1px solid var(--ok);
      border-radius: 10px;
      background: var(--surface);
      box-shadow: 0 1.5rem 3rem rgb(0 0 0 / 45%);
    }

    /* The panel takes focus so Escape reaches it, but it is a container rather
       than a control, and ringing it adds nothing a reader can act on. */
    .issued:focus-visible {
      outline: none;
    }

    .secret code {
      flex: 1;
      padding: var(--fx-2xs);
      border-radius: 6px;
      background: var(--bg);
      overflow-wrap: anywhere;
      user-select: all;
      font-size: var(--fx-typography-1);
    }

    .snippets {
      display: grid;
      gap: var(--fx-3xs);
      margin: 0;
    }

    .snippets div {
      display: grid;
      grid-template-columns: 4rem 1fr;
      align-items: center;
      gap: var(--fx-2xs);
    }

    .snippets dt {
      font-size: var(--fx-typography--1);
    }

    .snippets dd {
      display: flex;
      align-items: center;
      gap: var(--fx-3xs);
      margin: 0;
      min-width: 0;
    }

    .snippets code {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `,
})
export class AppsView implements OnInit {
  private readonly store = inject(AppsStore);

  protected readonly issued$ = this.store.issued$;

  /** Focus follows the dialog in, which is what makes Escape work and what
   * puts a screen reader on the key rather than on the page behind it. A
   * setter rather than ngAfterViewInit because the panel comes and goes with
   * the `@if`. */
  @ViewChild('panel')
  protected set panel(element: ElementRef<HTMLElement> | undefined) {
    element?.nativeElement.focus();
  }

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

  protected close(): void {
    this.store.dispatch('dismissIssued');
  }

  protected header(secret: string): string {
    return `Authorization: Bearer ${secret}`;
  }

  protected env(secret: string): string {
    return `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20${secret}`;
  }
}
