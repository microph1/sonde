import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { AsyncPipe, DatePipe } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { combineLatest, map } from 'rxjs';

import { App, AppsStore, KeyKind } from '../../core/apps.store';

@Component({
  selector: 'wt-apps-view',
  imports: [ReactiveFormsModule, AsyncPipe, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="fx-flex fx-items-center fx-gap-4 fx-mb-4">
      <h1>Apps &amp; keys</h1>
    </header>

    <p class="intro dim fx-mb-5">
      An app is what a key identifies. The receiver stamps every batch with the app its
      key belongs to, which is why that grouping can be trusted where
      <code>service.name</code> cannot — anything can claim to be any service, but only a
      key holder can claim to be an app.
    </p>

    @if (issued$ | async; as issued) {
      <aside class="issued fx-p-4 fx-mb-5" role="status">
        <strong>Copy this now — it is not stored anywhere.</strong>
        <code class="secret fx-my-2">{{ issued.secret }}</code>
        <span class="dim">
          {{ issued.kind === 'secret' ? 'Send it as' : 'Public key. Send it as' }}
          <code>Authorization: Bearer &lt;key&gt;</code>, or set
          <code>OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20&lt;key&gt;</code>.
        </span>
        <button type="button" class="fx-mt-3" (click)="dismiss()">I have copied it</button>
      </aside>
    }

    <section class="fx-mb-6">
      <h2>Apps</h2>

      <form [formGroup]="appForm" (ngSubmit)="createApp()" class="fx-flex fx-items-end fx-gap-3 fx-mb-3">
        <label>
          New app
          <input formControlName="name" placeholder="microgamma" />
        </label>
        <button type="submit" [disabled]="appForm.invalid">Create</button>
      </form>

      <table>
        <caption class="sr-only">Apps</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Keys</th>
            <th scope="col">Created</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          @for (app of appRows$ | async; track app.id) {
            <tr>
              <th scope="row" class="mono">{{ app.name }}</th>
              <td>{{ app.liveKeys }} live<span class="dim">{{ app.revokedKeys ? ' · ' + app.revokedKeys + ' revoked' : '' }}</span></td>
              <td>{{ app.createdAt | date: 'medium' }}</td>
              <td><button type="button" (click)="deleteApp(app)">Delete</button></td>
            </tr>
          } @empty {
            <tr><td colspan="4" class="dim">No apps yet. Telemetry can still arrive while ingest auth is off.</td></tr>
          }
        </tbody>
      </table>
    </section>

    <section>
      <h2>Keys</h2>

      <form [formGroup]="keyForm" (ngSubmit)="issueKey()" class="fx-flex fx-flex-wrap fx-items-end fx-gap-3 fx-mb-3">
        <label>
          App
          <select formControlName="appId">
            <option value="">choose…</option>
            @for (app of apps$ | async; track app.id) {
              <option [value]="app.id">{{ app.name }}</option>
            }
          </select>
        </label>
        <label>
          Kind
          <select formControlName="kind">
            <option value="secret">secret — backends</option>
            <option value="public">public — browsers</option>
          </select>
        </label>
        <label>
          Name
          <input formControlName="name" placeholder="relay" />
        </label>
        <label>
          Allowed origins
          <input
            formControlName="origins"
            placeholder="http://app.localhost, https://app.example"
            [attr.aria-describedby]="keyForm.value.kind === 'public' ? 'origins-help' : null"
          />
        </label>
        <button type="submit" [disabled]="keyForm.invalid">Issue key</button>
      </form>

      @if (keyForm.value.kind === 'public') {
        <p id="origins-help" class="dim fx-mb-3">
          A public key ships to browsers, so it is readable by anyone who opens devtools.
          Origins are what make it useful anyway — list every origin that should be able
          to use it, comma separated. Leave it empty and the key is accepted from anywhere.
        </p>
      }

      <table>
        <caption class="sr-only">API keys</caption>
        <thead>
          <tr>
            <th scope="col">Key</th>
            <th scope="col">App</th>
            <th scope="col">Kind</th>
            <th scope="col">Origins</th>
            <th scope="col">Created</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          @for (key of keyRows$ | async; track key.id) {
            <tr [class.revoked]="key.revoked">
              <th scope="row">
                <span class="mono">{{ key.hint }}</span>
                <span class="dim">{{ key.name }}</span>
              </th>
              <td class="mono">{{ key.appName }}</td>
              <td>{{ key.kind }}</td>
              <td class="mono dim">{{ key.origins.length ? key.origins.join(', ') : '—' }}</td>
              <td>{{ key.createdAt | date: 'medium' }}</td>
              <td>
                @if (key.revoked) {
                  <span class="dim">revoked</span>
                } @else {
                  <button type="button" (click)="revoke(key.id)">Revoke</button>
                }
              </td>
            </tr>
          } @empty {
            <tr><td colspan="6" class="dim">No keys issued.</td></tr>
          }
        </tbody>
      </table>
    </section>
  `,
  styles: `
    h2 {
      margin: 0 0 var(--fx-2xs);
      font-size: var(--fx-typography-1);
      font-weight: 600;
    }

    .intro {
      max-width: 70ch;
    }

    label {
      display: flex;
      flex-direction: column;
      gap: var(--fx-3xs);
      color: var(--text-dim);
      font-size: var(--fx-typography--1);
    }

    .issued {
      display: grid;
      border: 1px solid var(--ok);
      border-radius: 10px;
      background: color-mix(in srgb, var(--ok) 10%, transparent);
      justify-items: start;
      max-width: 70ch;
    }

    .secret {
      display: block;
      width: 100%;
      padding: var(--fx-2xs);
      border-radius: 6px;
      background: var(--bg);
      overflow-wrap: anywhere;
      user-select: all;
    }

    th span.dim {
      margin-inline-start: var(--fx-2xs);
    }

    tr.revoked th,
    tr.revoked td {
      opacity: 0.5;
      text-decoration: line-through;
    }

    tr.revoked td:last-child {
      text-decoration: none;
    }
  `,
})
export class AppsView implements OnInit {
  private readonly store = inject(AppsStore);

  protected readonly apps$ = this.store.apps$;
  protected readonly issued$ = this.store.issued$;

  /** Key counts belong beside the app they belong to, and the app's name beside
   * the key — both are joins the API deliberately does not do, because the two
   * lists are each useful on their own. */
  protected readonly appRows$ = combineLatest([this.store.apps$, this.store.keys$]).pipe(
    map(([apps, keys]) =>
      apps.map((app) => ({
        ...app,
        liveKeys: keys.filter((key) => key.appId === app.id && !key.revoked).length,
        revokedKeys: keys.filter((key) => key.appId === app.id && key.revoked).length,
      })),
    ),
  );

  protected readonly keyRows$ = combineLatest([this.store.keys$, this.store.apps$]).pipe(
    map(([keys, apps]) =>
      keys.map((key) => ({
        ...key,
        appName: apps.find((app) => app.id === key.appId)?.name ?? 'unknown',
      })),
    ),
  );

  protected readonly appForm = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });

  protected readonly keyForm = new FormGroup({
    appId: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    kind: new FormControl<KeyKind>('secret', { nonNullable: true }),
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    origins: new FormControl('', { nonNullable: true }),
  });

  ngOnInit(): void {
    this.store.dispatch('loadApps');
    this.store.dispatch('loadKeys');
  }

  protected createApp(): void {
    this.store.dispatch('createApp', this.appForm.getRawValue().name);
    this.appForm.reset();
  }

  protected deleteApp(app: App): void {
    this.store.dispatch('deleteApp', app.id);
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

    this.keyForm.patchValue({ name: '', origins: '' });
  }

  protected revoke(keyId: string): void {
    this.store.dispatch('revokeKey', keyId);
  }

  protected dismiss(): void {
    this.store.dispatch('dismissIssued');
  }
}
