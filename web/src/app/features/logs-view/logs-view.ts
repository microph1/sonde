import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { AsyncPipe, DatePipe } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { startWith } from 'rxjs';

import { LogsStore } from '../../core/logs.store';
import { LogFilters } from '../../core/telemetry.model';

@Component({
  selector: 'wt-logs-view',
  imports: [ReactiveFormsModule, RouterLink, AsyncPipe, DatePipe, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Logs</h1>

    <form [formGroup]="filters" (ngSubmit)="run()" class="filters fx-flex fx-flex-wrap fx-items-end fx-gap-3 fx-mb-4">
      <mat-form-field subscriptSizing="dynamic">
        <mat-label>Service</mat-label>
        <input matInput formControlName="service" placeholder="any" class="mono" />
      </mat-form-field>

      <mat-form-field subscriptSizing="dynamic" class="wide">
        <mat-label>Body contains</mat-label>
        <input matInput formControlName="contains" placeholder="any" />
      </mat-form-field>

      <mat-form-field subscriptSizing="dynamic">
        <mat-label>Minimum severity</mat-label>
        <mat-select formControlName="minSeverity">
          <mat-option [value]="0">any</mat-option>
          <mat-option [value]="5">DEBUG</mat-option>
          <mat-option [value]="9">INFO</mat-option>
          <mat-option [value]="13">WARN</mat-option>
          <mat-option [value]="17">ERROR</mat-option>
        </mat-select>
      </mat-form-field>

      <mat-form-field subscriptSizing="dynamic" class="narrow">
        <mat-label>Limit</mat-label>
        <input matInput formControlName="limit" type="number" min="1" />
      </mat-form-field>

      <button mat-flat-button type="submit" [disabled]="(live$ | async) ?? false">
        <mat-icon>search</mat-icon>
        Search
      </button>

      @if ((live$ | async) === true) {
        <button mat-stroked-button type="button" (click)="stop()">
          <mat-icon>stop</mat-icon>
          Stop tail
        </button>
      } @else {
        <button mat-stroked-button type="button" (click)="startLive()">
          <mat-icon>bolt</mat-icon>
          Live tail
        </button>
      }
    </form>

    <p class="status fx-flex fx-items-center fx-gap-2" aria-live="polite">
      @if ((live$ | async) === true) {
        <span class="pill">live</span>
      }
      {{ (rows$ | async)?.length ?? 0 }} records{{ (searching$ | async) ? ' — streaming…' : '' }}
    </p>

    <table>
      <caption class="sr-only">Matching log records</caption>
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Service</th>
          <th scope="col">Severity</th>
          <th scope="col">Body</th>
          <th scope="col">Trace</th>
        </tr>
      </thead>
      <tbody>
        @for (record of rows$ | async; track $index) {
          <tr>
            <td>{{ record.Timestamp | date: 'HH:mm:ss.SSS' }}</td>
            <td class="mono">{{ record.ServiceName }}</td>
            <td [class]="severityClass(record.SeverityNumber)">{{ record.SeverityText || '—' }}</td>
            <td class="body">{{ record.Body }}</td>
            <td>
              @if (record.TraceId) {
                <a class="mono" [routerLink]="['/traces', record.TraceId]">{{ record.TraceId.slice(0, 12) }}…</a>
              }
            </td>
          </tr>
        } @empty {
          @if (!(searching$ | async)) {
            <tr><td colspan="5" class="hint">No records matched.</td></tr>
          }
        }
      </tbody>
    </table>
  `,
  styles: `
    .filters mat-form-field {
      min-width: 11rem;
    }

    .filters mat-form-field.wide {
      min-width: 18rem;
    }

    .filters mat-form-field.narrow {
      min-width: 7.5rem;
    }

    /* Layout is in the template; this is what the utilities do not cover. */
    .filters label {
      display: flex;
      flex-direction: column;
      gap: var(--fx-3xs);
      color: var(--text-dim);
      font-size: var(--fx-typography--1);
    }

    .body {
      font-family: ui-monospace, monospace;
      font-size: 0.9em;
      max-width: 60ch;
      overflow-wrap: anywhere;
    }

    .status {
      color: var(--text-dim);
    }

    .hint {
      color: var(--text-dim);
    }

    .sev-error {
      color: var(--error);
    }

    .sev-warn {
      color: var(--warn);
    }

    .sev-info {
      color: var(--text);
    }

    .sev-debug {
      color: var(--text-dim);
    }
  `,
})
export class LogsView implements OnInit {
  private readonly store = inject(LogsStore);
  private readonly route = inject(ActivatedRoute);

  protected readonly filters = new FormGroup({
    service: new FormControl(this.route.snapshot.queryParamMap.get('service') ?? ''),
    contains: new FormControl(this.route.snapshot.queryParamMap.get('contains') ?? ''),
    minSeverity: new FormControl(Number(this.route.snapshot.queryParamMap.get('minSeverity') ?? 0)),
    limit: new FormControl(200),
  });

  protected readonly rows$ = this.store.rows$;
  protected readonly live$ = this.store.live$;
  protected readonly searching$ = this.store.getLoadingFor('search').pipe(startWith(false));

  ngOnInit(): void {
    // A `live=1` query param opens straight into the tail, so a link can share
    // "watch this" rather than "search this".
    if (this.route.snapshot.queryParamMap.get('live') === '1') {
      this.startLive();
      return;
    }

    this.run();
  }

  protected run(): void {
    this.store.dispatch('search', this.currentFilters());
  }

  protected startLive(): void {
    this.store.dispatch('tail', this.currentFilters());
  }

  protected stop(): void {
    this.store.dispatch('stop');
  }

  /** OTel severity numbers: 1-4 trace, 5-8 debug, 9-12 info, 13-16 warn, 17+ error. */
  protected severityClass(severity: number): string {
    if (severity >= 17) return 'sev-error';
    if (severity >= 13) return 'sev-warn';
    if (severity >= 9) return 'sev-info';
    return 'sev-debug';
  }

  private currentFilters(): LogFilters {
    const { service, contains, minSeverity, limit } = this.filters.getRawValue();

    return {
      service: service ?? '',
      contains: contains ?? '',
      minSeverity: Number(minSeverity ?? 0),
      limit: limit ?? 200,
    };
  }
}
