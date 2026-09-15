import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { RowStream } from '../../core/stream';
import { Telemetry } from '../../core/telemetry';
import { LogRecord } from '../../core/telemetry.model';

@Component({
  selector: 'wt-logs-view',
  imports: [ReactiveFormsModule, RouterLink, DatePipe],
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
      <button type="submit">Search</button>
      @if (streaming()) {
        <button type="button" (click)="stop()">Stop</button>
      }
    </form>

    <p class="status" aria-live="polite">
      {{ rows().length }} records{{ streaming() ? ' — streaming…' : '' }}
    </p>

    @if (error(); as message) {
      <p role="alert" class="error">{{ message }}</p>
    }

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
        @for (record of rows(); track $index) {
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
          @if (!streaming()) {
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

    .status { color: var(--text-dim); }
    .error { color: var(--error); }
    .hint { color: var(--text-dim); }
    .sev-error { color: var(--error); }
    .sev-warn { color: var(--warn); }
    .sev-info { color: var(--text); }
    .sev-debug { color: var(--text-dim); }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
  `,
})
export class LogsView {
  private readonly telemetry = inject(Telemetry);
  private readonly route = inject(ActivatedRoute);

  protected readonly filters = new FormGroup({
    service: new FormControl(this.route.snapshot.queryParamMap.get('service') ?? ''),
    contains: new FormControl(''),
    minSeverity: new FormControl(0),
    limit: new FormControl(200),
  });

  private readonly stream = signal<RowStream<LogRecord> | null>(null);

  protected readonly rows = computed(() => this.stream()?.rows() ?? []);
  protected readonly streaming = computed(() => this.stream()?.state() === 'streaming');
  protected readonly error = computed(() => this.stream()?.error() ?? null);

  constructor() {
    this.run();

    effect((onCleanup) => {
      const current = this.stream();
      onCleanup(() => current?.cancel());
    });
  }

  protected run(): void {
    const { service, contains, minSeverity, limit } = this.filters.getRawValue();

    this.stream.set(
      this.telemetry.searchLogs({
        service: service ?? '',
        contains: contains ?? '',
        minSeverity: Number(minSeverity ?? 0),
        limit: limit ?? 200,
      }),
    );
  }

  protected stop(): void {
    this.stream()?.cancel();
  }

  /** OTel severity numbers: 1-4 trace, 5-8 debug, 9-12 info, 13-16 warn, 17+ error. */
  protected severityClass(severity: number): string {
    if (severity >= 17) return 'sev-error';
    if (severity >= 13) return 'sev-warn';
    if (severity >= 9) return 'sev-info';
    return 'sev-debug';
  }
}
