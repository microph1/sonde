import { ChangeDetectionStrategy, Component, computed, inject, resource, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import { Telemetry } from '../../core/telemetry';
import { VolumeChart } from '../../shared/volume-chart';

/** Windows offered above the charts, with a bucket that keeps every one of them
 * at roughly 50-70 points — dense enough to show shape, sparse enough to stay
 * readable at this width. */
const RANGES = [
  { label: '1h', windowMinutes: 60, bucketSeconds: 60, bucketLabel: 'minute' },
  { label: '6h', windowMinutes: 360, bucketSeconds: 300, bucketLabel: '5 minutes' },
  { label: '24h', windowMinutes: 1440, bucketSeconds: 1800, bucketLabel: '30 minutes' },
  { label: '7d', windowMinutes: 10080, bucketSeconds: 10800, bucketLabel: '3 hours' },
] as const;

@Component({
  selector: 'wt-services-view',
  imports: [RouterLink, DatePipe, DecimalPipe, VolumeChart],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="page">
      <h1>Services</h1>
      <div class="ranges" role="group" aria-label="Time range">
        @for (option of ranges; track option.label) {
          <button
            type="button"
            [class.active]="option.label === range().label"
            [attr.aria-pressed]="option.label === range().label"
            (click)="range.set(option)"
          >
            {{ option.label }}
          </button>
        }
      </div>
    </header>

    <div class="tiles">
      @for (tile of tiles(); track tile.label) {
        <article class="tile">
          <span class="label">{{ tile.label }}</span>
          <strong class="value" [class.alarming]="tile.alarming">{{ tile.value | number }}</strong>
          <span class="detail">{{ tile.detail }}</span>
        </article>
      }
    </div>

    @if (volume.error(); as error) {
      <p role="alert" class="error">{{ error }}</p>
    }

    <div class="charts">
      <wt-volume-chart
        [points]="points()"
        metric="spans"
        title="Spans"
        [unit]="'per ' + range().bucketLabel"
      />
      <wt-volume-chart
        [points]="points()"
        metric="logs"
        title="Log records"
        [unit]="'per ' + range().bucketLabel"
      />
    </div>

    @if (services.isLoading()) {
      <p class="hint">Loading…</p>
    } @else if (services.error(); as error) {
      <p role="alert" class="error">{{ error }}</p>
    } @else {
      <table>
        <caption class="sr-only">Services reporting telemetry</caption>
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">Spans</th>
            <th scope="col">Logs</th>
            <th scope="col">Last seen</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          @for (service of services.value(); track service.ServiceName) {
            <tr>
              <th scope="row" class="mono">{{ service.ServiceName }}</th>
              <td>{{ service.traces | number }}</td>
              <td>{{ service.logs | number }}</td>
              <td>{{ service.lastSeen | date: 'medium' }}</td>
              <td class="links">
                <a [routerLink]="['/traces']" [queryParams]="{ service: service.ServiceName }">traces</a>
                <a [routerLink]="['/logs']" [queryParams]="{ service: service.ServiceName }">logs</a>
              </td>
            </tr>
          } @empty {
            <tr><td colspan="5" class="hint">Nothing has reported yet.</td></tr>
          }
        </tbody>
      </table>
    }
  `,
  styles: `
    .page {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1rem;
    }

    h1 {
      margin: 0;
    }

    .ranges {
      margin-inline-start: auto;
      display: flex;
      gap: 0.25rem;
    }

    .ranges button.active {
      border-color: var(--accent);
      color: var(--text);
    }

    .tiles {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
      gap: 0.75rem;
      margin-bottom: 1.25rem;
    }

    .tile {
      display: grid;
      gap: 0.15rem;
      padding: 0.75rem 0.9rem;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--surface);
    }

    .tile .label {
      color: var(--text-dim);
      font-size: 0.8rem;
    }

    .tile .value {
      font-size: 1.6rem;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      line-height: 1.1;
    }

    .tile .value.alarming {
      color: var(--error);
    }

    .tile .detail {
      color: var(--text-dim);
      font-size: 0.75rem;
    }

    .charts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(28rem, 1fr));
      gap: 1.5rem 2rem;
      margin-bottom: 1.75rem;
    }

    .links {
      display: flex;
      gap: 0.75rem;
    }

    .hint {
      color: var(--text-dim);
    }

    .error {
      color: var(--error);
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
export class ServicesView {
  private readonly telemetry = inject(Telemetry);

  protected readonly ranges = RANGES;
  protected readonly range = signal<(typeof RANGES)[number]>(RANGES[2]);

  protected readonly services = resource({
    loader: () => this.telemetry.services(),
  });

  protected readonly volume = resource({
    params: () => this.range(),
    loader: ({ params }) => this.telemetry.timeseries(params.windowMinutes, params.bucketSeconds),
  });

  protected readonly points = computed(() => this.volume.value() ?? []);

  /**
   * Headline numbers for the window. These are the questions asked often enough
   * that they should not need a chart read: how much is arriving, from how many
   * services, and how much of it is bad.
   */
  protected readonly tiles = computed(() => {
    const points = this.points();
    const spans = points.reduce((sum, point) => sum + point.spans, 0);
    const logs = points.reduce((sum, point) => sum + point.logs, 0);
    const errors = points.reduce((sum, point) => sum + point.errors, 0);
    const services = new Set(points.map((point) => point.ServiceName)).size;
    const window = this.range().label;

    return [
      { label: 'Spans', value: spans, detail: `last ${window}`, alarming: false },
      { label: 'Log records', value: logs, detail: `last ${window}`, alarming: false },
      {
        label: 'Errors',
        value: errors,
        detail: spans + logs > 0 ? `${((errors / (spans + logs)) * 100).toFixed(1)}% of records` : '—',
        alarming: errors > 0,
      },
      { label: 'Services reporting', value: services, detail: `last ${window}`, alarming: false },
    ];
  });
}
