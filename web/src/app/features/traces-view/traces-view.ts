import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { AsyncPipe, DatePipe } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { startWith } from 'rxjs';

import { TracesStore } from '../../core/traces.store';
import { TraceFilters } from '../../core/telemetry.model';
import { DurationPipe } from '../../shared/duration-pipe';

@Component({
  selector: 'wt-traces-view',
  imports: [ReactiveFormsModule, RouterLink, AsyncPipe, DatePipe, DurationPipe],
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
      {{ (rows$ | async)?.length ?? 0 }} spans{{ (searching$ | async) ? ' — streaming…' : '' }}
    </p>

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
        @for (span of rows$ | async; track span.SpanId) {
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
          @if (!(searching$ | async)) {
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

    .status { color: var(--text-dim); display: flex; align-items: center; gap: 0.5rem; }
    .error { color: var(--error); }
    .hint { color: var(--text-dim); }
    .num { text-align: right; font-variant-numeric: tabular-nums; }

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

    .pill.connecting {
      background: color-mix(in srgb, var(--warn) 18%, transparent);
      color: var(--warn);
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
export class TracesView implements OnInit {
  private readonly store = inject(TracesStore);
  private readonly route = inject(ActivatedRoute);

  protected readonly filters = new FormGroup({
    // Seeded from the URL so a link can carry a filtered view — the overview's
    // tiles arrive here with one already applied.
    service: new FormControl(this.route.snapshot.queryParamMap.get('service') ?? ''),
    name: new FormControl(this.route.snapshot.queryParamMap.get('name') ?? ''),
    status: new FormControl(this.route.snapshot.queryParamMap.get('status') ?? ''),
    minDurationMs: new FormControl<number | null>(null),
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

  private currentFilters(): TraceFilters {
    const { service, name, status, minDurationMs, limit } = this.filters.getRawValue();

    return {
      service: service ?? '',
      name: name ?? '',
      status: status ?? '',
      minDurationMs: minDurationMs ?? 0,
      limit: limit ?? 200,
    };
  }
}
