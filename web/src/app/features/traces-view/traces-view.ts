import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { RowStream } from '../../core/stream';
import { Telemetry } from '../../core/telemetry';
import { Span } from '../../core/telemetry.model';
import { DurationPipe } from '../../shared/duration-pipe';

@Component({
  selector: 'wt-traces-view',
  imports: [ReactiveFormsModule, RouterLink, DatePipe, DurationPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Traces</h1>

    <form [formGroup]="filters" (ngSubmit)="run()" class="filters">
      <label>Service <input formControlName="service" placeholder="any" class="mono" /></label>
      <label>Span name <input formControlName="name" placeholder="any" class="mono" /></label>
      <label>
        Status
        <select formControlName="status">
          <option value="">any</option>
          <option value="Ok">Ok</option>
          <option value="Error">Error</option>
          <option value="Unset">Unset</option>
        </select>
      </label>
      <label>Slower than (ms) <input formControlName="minDurationMs" type="number" min="0" /></label>
      <label>Limit <input formControlName="limit" type="number" min="1" /></label>
      <button type="submit">Search</button>
      @if (streaming()) {
        <button type="button" (click)="stop()">Stop</button>
      }
    </form>

    <p class="status" aria-live="polite">
      {{ rows().length }} spans{{ streaming() ? ' — streaming…' : '' }}
    </p>

    @if (error(); as message) {
      <p role="alert" class="error">{{ message }}</p>
    }

    <table>
      <caption class="sr-only">Matching spans</caption>
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Service</th>
          <th scope="col">Span</th>
          <th scope="col">Kind</th>
          <th scope="col">Duration</th>
          <th scope="col">Status</th>
          <th scope="col">Trace</th>
        </tr>
      </thead>
      <tbody>
        @for (span of rows(); track span.SpanId) {
          <tr>
            <td>{{ span.Timestamp | date: 'HH:mm:ss.SSS' }}</td>
            <td class="mono">{{ span.ServiceName }}</td>
            <td>{{ span.SpanName }}</td>
            <td>{{ span.SpanKind }}</td>
            <td class="num">{{ span.Duration | duration }}</td>
            <td [class]="'status-' + span.StatusCode">{{ span.StatusCode }}</td>
            <td>
              <a class="mono" [routerLink]="['/traces', span.TraceId]">{{ span.TraceId.slice(0, 12) }}…</a>
            </td>
          </tr>
        } @empty {
          @if (!streaming()) {
            <tr><td colspan="7" class="hint">No spans matched.</td></tr>
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

    .status { color: var(--text-dim); }
    .error { color: var(--error); }
    .hint { color: var(--text-dim); }
    .num { text-align: right; font-variant-numeric: tabular-nums; }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
  `,
})
export class TracesView {
  private readonly telemetry = inject(Telemetry);
  private readonly route = inject(ActivatedRoute);

  protected readonly filters = new FormGroup({
    service: new FormControl(this.route.snapshot.queryParamMap.get('service') ?? ''),
    name: new FormControl(''),
    status: new FormControl(''),
    minDurationMs: new FormControl<number | null>(null),
    limit: new FormControl(200),
  });

  private readonly stream = signal<RowStream<Span> | null>(null);

  protected readonly rows = computed(() => this.stream()?.rows() ?? []);
  protected readonly streaming = computed(() => this.stream()?.state() === 'streaming');
  protected readonly error = computed(() => this.stream()?.error() ?? null);

  constructor() {
    this.run();

    // A new search replaces the old stream; the abandoned one is aborted so its
    // rows stop arriving and the request stops occupying the server.
    effect((onCleanup) => {
      const current = this.stream();
      onCleanup(() => current?.cancel());
    });
  }

  protected run(): void {
    const { service, name, status, minDurationMs, limit } = this.filters.getRawValue();

    this.stream.set(
      this.telemetry.searchTraces({
        service: service ?? '',
        name: name ?? '',
        status: status ?? '',
        minDurationMs: minDurationMs ?? 0,
        limit: limit ?? 200,
      }),
    );
  }

  protected stop(): void {
    this.stream()?.cancel();
  }
}
