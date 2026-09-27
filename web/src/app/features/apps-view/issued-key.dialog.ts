import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

import { IssuedKey } from '../../core/apps.store';
import { CopyButton } from '../../shared/copy-button';

/**
 * The one time a key is readable.
 *
 * A dialog rather than a panel on the page: issuing from the last card used to
 * scroll the only copy of the secret out of sight, and this is the one moment
 * here that cannot be repeated — sonde keeps a hash, so closing this without
 * copying means minting another key.
 */
@Component({
  selector: 'wt-issued-key-dialog',
  imports: [MatDialogModule, MatButtonModule, MatIconModule, CopyButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>
      <mat-icon class="ok">check_circle</mat-icon>
      {{ issued.name }} issued
    </h2>

    <mat-dialog-content>
      <p class="dim">
        Copy it now — sonde keeps only a hash of this key, so this is the last time
        anyone can read it.
      </p>

      <div class="secret fx-flex fx-items-center fx-gap-2 fx-my-3">
        <code>{{ issued.secret }}</code>
        <wt-copy [value]="issued.secret" label="Copy the key" text="Copy" />
      </div>

      <dl class="snippets">
        <div>
          <dt class="dim">Header</dt>
          <dd>
            <code>Authorization: Bearer {{ issued.secret }}</code>
            <wt-copy [value]="header" label="Copy the Authorization header" />
          </dd>
        </div>
        <div>
          <dt class="dim">Env</dt>
          <dd>
            <code>OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20{{ issued.secret }}</code>
            <wt-copy [value]="env" label="Copy the exporter environment variable" />
          </dd>
        </div>
      </dl>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-flat-button mat-dialog-close>Done</button>
    </mat-dialog-actions>
  `,
  styles: `
    h2 {
      display: flex;
      align-items: center;
      gap: var(--fx-2xs);
    }

    .ok {
      color: var(--ok);
    }

    p {
      margin: 0;
      max-width: 60ch;
    }

    .secret code {
      flex: 1;
      padding: var(--fx-2xs);
      border-radius: var(--mat-sys-corner-small);
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
export class IssuedKeyDialog {
  protected readonly issued = inject<IssuedKey>(MAT_DIALOG_DATA);

  protected readonly header = `Authorization: Bearer ${this.issued.secret}`;
  protected readonly env = `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20${this.issued.secret}`;
}
