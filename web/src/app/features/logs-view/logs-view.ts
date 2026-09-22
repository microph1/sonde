import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { AsyncPipe, DatePipe } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { startWith } from 'rxjs';

import { LogsStore } from '../../core/logs.store';
import { LogFilters } from '../../core/telemetry.model';

@Component({
  selector: 'wt-logs-view',
  imports: [ReactiveFormsModule, RouterLink, AsyncPipe, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Logs</h1>

    <form [formGroup]="filters" (ngSubmit)="run()" class="filters">
      <label>Service <input formControlName="service" placeholder="any" class="mono" /></label>
      <label>Body contains <input formControlName="contains" placeholder="any" /></label>
      <label>
        Minimum severity
        <select formControlName="minSeverity">
          <option [value]="0">any</option>
          <option [value]="5">DEBUG</option>
          <option [value]="9">INFO</option>
          <option [value]="13">WARN</option>
          <option [value]="17">ERROR</option>
        </select>
      </label>
      <label>Limit <input formControlName="limit" type="number" min="1" /></label>
      <button type="submit" [disabled]="(live$ | async) ?? false">Search</button>
      @if ((live$ | async) === true) {
        <button type="button" (click)="stop()">Stop tail</button>
      } @else {
        <button type="button" (click)="startLive()">Live tail</button>
      }
    </form>

    <p class="status" aria-live="polite">
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
    .filters {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: 0.75rem;
      margin-bottom: 1rem;
    }

    .filters label {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      color: var(--text-dim);
      font-size: 0.85rem;
    }

    .body {
      font-family: ui-monospace, monospace;
      font-size: 0.9em;
      max-width: 60ch;
      overflow-wrap: anywhere;
    }

    .status { color: var(--text-dim); display: flex; align-items: center; gap: 0.5rem; }
    .hint { color: var(--text-dim); }
    .sev-error { color: var(--error); }
    .sev-warn { color: var(--warn); }
    .sev-info { color: var(--text); }
    .sev-debug { color: var(--text-dim); }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.1rem 0.5rem;
      border-radius: 999px;
      background: color-mix(in srgb, var(--ok) 18%, transparent);
      color: var(--ok);
      font-size: 0.8rem;
    }

    .pill::before {
      content: '';
      width: 0.45rem;
      height: 0.45rem;
      border-radius: 50%;
      background: currentColor;
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
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
