import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { AsyncPipe } from '@angular/common';
import { map } from 'rxjs';

import { MetricSummary, MetricsStore } from '../../core/metrics.store';
import { RANGES, Range } from '../../core/services.store';
import { VolumeChart } from '../../shared/volume-chart';

@Component({
  selector: 'wt-metrics-view',
  imports: [AsyncPipe, VolumeChart],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="fx-flex fx-items-center fx-gap-4 fx-mb-4">
      <h1>Metrics</h1>

      <label class="control fx-ml-a">
        Metric
        <select (change)="select($event)">
          @for (metric of catalogue$ | async; track metric.name + metric.kind) {
            <option [value]="metric.name + '|' + metric.kind" [selected]="metric.name === (selectedName$ | async)">
              {{ metric.name }}{{ metric.unit ? ' (' + metric.unit + ')' : '' }}
            </option>
          }
        </select>
      </label>

      @if (selected$ | async; as metric) {
        @if (metric.kind === 'sum') {
          <label class="control">
            <input type="checkbox" [checked]="(rate$ | async) ?? false" (change)="toggleRate($event)" />
            per second
          </label>
        }
      }

      <div class="ranges fx-flex fx-gap-1" role="group" aria-label="Time range">
        @for (option of ranges; track option.label) {
          <button
            type="button"
            [class.active]="option.label === (rangeLabel$ | async)"
            [attr.aria-pressed]="option.label === (rangeLabel$ | async)"
            (click)="selectRange(option)"
          >
            {{ option.label }}
          </button>
        }
      </div>
    </header>

    @if (selected$ | async; as metric) {
      <p class="dim fx-mb-4">
        {{ metric.description || 'No description supplied by the instrument.' }}
        <span class="mono">· {{ metric.kind }}{{ metric.monotonic ? ', monotonic' : '' }} · {{ metric.series }} series</span>
      </p>

      <div class="chart fx-mb-6">
        <wt-volume-chart
          [points]="(points$ | async) ?? []"
          [reference]="(reference$ | async) ?? null"
          [format]="formatter(metric)"
          [title]="metric.name"
          [unit]="unitLabel(metric)"
        />
      </div>
    } @else {
      <p class="dim">Nothing has reported a metric yet.</p>
    }

    <table>
      <caption class="sr-only">Metrics reported</caption>
      <thead>
        <tr>
          <th scope="col">Metric</th>
          <th scope="col">Kind</th>
          <th scope="col">Unit</th>
          <th scope="col">Series</th>
        </tr>
      </thead>
      <tbody>
        @for (metric of catalogue$ | async; track metric.name + metric.kind) {
          <tr [class.current]="metric.name === (selectedName$ | async)">
            <th scope="row" class="mono">
              <button type="button" class="link" (click)="pick(metric)">{{ metric.name }}</button>
            </th>
            <td>{{ metric.kind }}{{ metric.monotonic ? ' · monotonic' : '' }}</td>
            <td>{{ metric.unit || '—' }}</td>
            <td class="num">{{ metric.series }}</td>
          </tr>
        }
      </tbody>
    </table>
  `,
  styles: `
    .control {
      display: flex;
      align-items: center;
      gap: var(--fx-3xs);
      color: var(--text-dim);
      font-size: var(--fx-typography--1);
    }

    .ranges button.active {
      border-color: var(--accent);
      color: var(--text);
    }

    .chart {
      max-width: 60rem;
    }

    .link {
      background: none;
      border: none;
      padding: 0;
      color: var(--accent);
      font: inherit;
      cursor: pointer;
    }

    tr.current th .link {
      color: var(--text);
      font-weight: 600;
    }
  `,
})
export class MetricsView implements OnInit {
  private readonly store = inject(MetricsStore);

  protected readonly ranges = RANGES;
  protected readonly catalogue$ = this.store.catalogue$;
  protected readonly selected$ = this.store.selected$;
  protected readonly points$ = this.store.points$;
  protected readonly rate$ = this.store.rate$;
  protected readonly reference$ = this.store.reference$;
  protected readonly rangeLabel$ = this.store.range$.pipe(map((range) => range.label));
  protected readonly selectedName$ = this.store.selected$.pipe(map((metric) => metric?.name ?? ''));

  ngOnInit(): void {
    this.store.dispatch('loadCatalogue');
  }

  protected select(event: Event): void {
    this.store.dispatch('selectMetric', (event.target as HTMLSelectElement).value);
  }

  protected pick(metric: MetricSummary): void {
    this.store.dispatch('selectMetric', `${metric.name}|${metric.kind}`);
  }

  protected selectRange(range: Range): void {
    this.store.dispatch('selectRange', range);
  }

  protected toggleRate(event: Event): void {
    this.store.dispatch('toggleRate', (event.target as HTMLInputElement).checked);
  }

  /** Bytes read as bytes; everything else as a plain number. */
  protected formatter(metric: MetricSummary): (value: number) => string {
    if (metric.unit === 'By') {
      return bytes;
    }

    return (value: number) => (value >= 100 ? value.toFixed(0) : value.toFixed(2));
  }

  protected unitLabel(metric: MetricSummary): string {
    return metric.kind === 'sum' ? 'per second' : metric.unit || 'value';
  }
}

function bytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} kB`;

  return `${value.toFixed(0)} B`;
}
