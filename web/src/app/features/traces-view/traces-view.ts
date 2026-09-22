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

    <form [formGroup]="filters" (ngSubmit)="run()" class="filters fx-flex fx-flex-wrap fx-items-end fx-gap-3 fx-mb-4">
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

    <p class="status fx-flex fx-items-center fx-gap-2" aria-live="polite">
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
    /* Layout is in the template; this is what the utilities do not cover. */
    .filters label {
      display: flex;
      flex-direction: column;
      gap: var(--fx-3xs);
      color: var(--text-dim);
      font-size: var(--fx-typography--1);
    }

    .status {
      color: var(--text-dim);
    }

    .hint {
      color: var(--text-dim);
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
