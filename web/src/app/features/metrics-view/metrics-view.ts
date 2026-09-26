import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { AsyncPipe } from '@angular/common';
import { map } from 'rxjs';

import { MetricOverview, MetricSummary, MetricsStore } from '../../core/metrics.store';
import { RANGES, Range } from '../../core/services.store';
import { Sparkline } from '../../shared/sparkline';
import { VolumeChart } from '../../shared/volume-chart';

@Component({
  selector: 'wt-metrics-view',
  imports: [AsyncPipe, VolumeChart, Sparkline],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="fx-flex fx-items-center fx-flex-wrap fx-gap-4 fx-mb-4">
      <h1>Metrics</h1>

      @if (selected$ | async; as metric) {
        @if (metric.kind === 'sum') {
          <label class="control">
            <input type="checkbox" [checked]="(rate$ | async) ?? false" (change)="toggleRate($event)" />
            per second
          </label>
        }
      }

      <div class="ranges fx-flex fx-gap-1 fx-ml-a" role="group" aria-label="Time range">
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
      <section class="detail fx-mb-6">
        <wt-volume-chart
          [points]="(points$ | async) ?? []"
          [reference]="(reference$ | async) ?? null"
          [format]="formatter(metric)"
          [title]="metric.name"
          [unit]="unitLabel(metric)"
        />

        <p class="dim fx-mt-2">
          {{ metric.description || 'No description supplied by the instrument.' }}
          <span class="mono">
            · {{ metric.kind }}{{ metric.monotonic ? ', monotonic' : '' }} · {{ metric.series }}
            {{ metric.series === 1 ? 'series' : 'series' }}
          </span>
        </p>
      </section>
    }

    <h2 class="sr-only">Everything reporting</h2>

    <section class="cards">
      @for (metric of overview$ | async; track metric.name + metric.kind) {
        <button
          type="button"
          class="card"
          [class.current]="metric.name === (selectedName$ | async)"
          [attr.aria-pressed]="metric.name === (selectedName$ | async)"
          (click)="pick(metric)"
        >
          <span class="top fx-flex fx-items-baseline fx-gap-2">
            <!-- The name is ellipsised to keep every card the same width, so
                 the full one has to stay reachable. -->
            <span class="name mono" [title]="metric.name">{{ metric.name }}</span>
            <span class="badge fx-ml-a">{{ reading(metric) }}</span>
          </span>

          <span class="value">
            {{ display(metric) }}<small class="suffix">{{ suffix(metric) }}</small>
          </span>

          <wt-sparkline
            [points]="metric.points"
            [label]="metric.name + ', ' + reading(metric) + ' over the selected window'"
          />

          <span class="foot dim">
            {{ metric.series }} {{ metric.series === 1 ? 'series' : 'series' }}
            @if (metric.unit) {
              · {{ metric.unit }}
            }
          </span>
        </button>
      } @empty {
        <p class="dim">Nothing has reported a metric yet.</p>
      }
    </section>
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

    .detail {
      max-width: 60rem;
    }

    /* Intrinsic: the column count is decided by how much room there is, not by
       a breakpoint someone picked. */
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
      gap: var(--fx-s);
    }

    .card {
      display: grid;
      /* Both halves of the same fix: a grid item and a grid track size to auto
         by default, which means as wide as the longest unbreakable thing
         inside. A metric name is one long unbreakable thing, so without these
         the card grows past its column and its sparkline draws over the card
         next to it. */
      min-width: 0;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--fx-3xs);
      padding: var(--fx-2xs) var(--fx-s) var(--fx-s);
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--surface);
      text-align: left;
      cursor: pointer;
    }

    .card:hover,
    .card:focus-visible {
      border-color: var(--accent);
      background: var(--surface-raised);
    }

    .card.current {
      border-color: var(--accent);
      background: var(--surface-raised);
    }

    .top {
      min-width: 0;
    }

    .name {
      min-width: 0;
      font-size: var(--fx-typography--1);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .badge {
      padding: 0.05rem 0.4rem;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--text-dim);
      font-size: var(--fx-typography--2);
      white-space: nowrap;
    }

    .value {
      font-size: var(--fx-typography-3);
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      line-height: 1.1;
    }

    .suffix {
      margin-inline-start: 0.15em;
      color: var(--text-dim);
      font-size: var(--fx-typography--1);
      font-weight: 400;
    }

    .foot {
      font-size: var(--fx-typography--2);
    }
  `,
})
export class MetricsView implements OnInit {
  private readonly store = inject(MetricsStore);

  protected readonly ranges = RANGES;
  protected readonly overview$ = this.store.overview$;
  protected readonly selected$ = this.store.selected$;
  protected readonly points$ = this.store.points$;
  protected readonly rate$ = this.store.rate$;
  protected readonly reference$ = this.store.reference$;
  protected readonly rangeLabel$ = this.store.range$.pipe(map((range) => range.label));
  protected readonly selectedName$ = this.store.selected$.pipe(map((metric) => metric?.name ?? ''));

  ngOnInit(): void {
    this.store.dispatch('loadCatalogue');
  }

  protected pick(metric: MetricOverview): void {
    this.store.dispatch('selectMetric', `${metric.name}|${metric.kind}`);
  }

  protected selectRange(range: Range): void {
    this.store.dispatch('selectRange', range);
  }

  protected toggleRate(event: Event): void {
    this.store.dispatch('toggleRate', (event.target as HTMLInputElement).checked);
  }

  /**
   * What the card's figure and line actually mean.
   *
   * A cumulative counter and a histogram's count are only legible as a rate; a
   * gauge is a reading; an up-down counter is a level. Saying which one is on
   * the card is the difference between a number and a number you can trust.
   */
  protected reading(metric: MetricSummary): string {
    if (metric.kind === 'histogram' || (metric.kind === 'sum' && metric.monotonic)) {
      return 'rate';
    }

    return metric.kind === 'sum' ? 'level' : 'gauge';
  }

  protected display(metric: MetricOverview): string {
    if (metric.latest === null) {
      return '—';
    }

    return this.formatter(metric)(metric.latest);
  }

  protected suffix(metric: MetricOverview): string {
    if (metric.latest === null) {
      return '';
    }

    return this.reading(metric) === 'rate' ? '/s' : '';
  }

  /**
   * Bytes read as bytes, seconds as time, everything else as a plain number.
   *
   * A histogram is the exception: its card reads observations per second, and
   * a count of observations is not measured in the unit of the thing observed.
   * Formatting the rate of `http.server.request.duration` in milliseconds gave
   * a card reading "microseconds per second", which is not a quantity.
   */
  protected formatter(metric: MetricSummary): (value: number) => string {
    if (metric.kind === 'histogram') {
      return count;
    }

    if (metric.unit === 'By') {
      return bytes;
    }

    if (metric.unit === 's' || metric.unit === 'ms') {
      return metric.unit === 's' ? seconds : (value: number) => seconds(value / 1000);
    }

    return count;
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

function seconds(value: number): string {
  if (value >= 1) return `${value.toFixed(2)} s`;
  if (value >= 0.001) return `${(value * 1000).toFixed(0)} ms`;

  return `${(value * 1_000_000).toFixed(0)} µs`;
}

/** Enough significance to tell 0.02 from 0, without six decimals of noise on a
 * number that happens to be large. */
function count(value: number): string {
  if (value === 0) return '0';
  if (Math.abs(value) >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (Math.abs(value) >= 10) return value.toFixed(1);

  return value.toFixed(2);
}
