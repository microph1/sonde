import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { AsyncPipe, DatePipe, DecimalPipe } from '@angular/common';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { combineLatest, filter, map, startWith, withLatestFrom } from 'rxjs';

import { DEFAULT_RANGE, RANGES, Range, ServicesStore } from '../../core/services.store';
import { PageHeader } from '../../shared/page-header';
import { VolumeChart } from '../../shared/volume-chart';

@Component({
  selector: 'wt-services-view',
  imports: [
    RouterLink,
    AsyncPipe,
    DatePipe,
    DecimalPipe,
    VolumeChart,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatSelectModule, PageHeader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (range$ | async; as range) {
      <wt-page-header
        heading="Services"
        subtitle="What is reporting, how much of it, and how much of that went wrong."
      >
        <mat-form-field class="grouping" subscriptSizing="dynamic">
          <mat-label>Group by</mat-label>
          <mat-select
            [value]="(grouping$ | async) ?? 'service'"
            (selectionChange)="selectGrouping($event.value)"
          >
            @for (option of groupings$ | async; track option.key) {
              <mat-option [value]="option.key">{{ option.label }}</mat-option>
            }
          </mat-select>
        </mat-form-field>

        <mat-button-toggle-group aria-label="Time range" hideSingleSelectionIndicator [value]="range.label">
          @for (option of ranges; track option.label) {
            <mat-button-toggle [value]="option.label" (click)="select(option)">
              {{ option.label }}
            </mat-button-toggle>
          }
        </mat-button-toggle-group>
      </wt-page-header>

      <div class="tiles fx-gap-2 fx-mb-5">
        @for (tile of tiles$ | async; track tile.label) {
          <a
            class="tile fx-grid fx-gap-1 fx-p-3"
            [routerLink]="tile.link"
            [queryParams]="tile.params"
            [fragment]="tile.fragment"
            queryParamsHandling="merge"
          >
            <span class="label">{{ tile.label }}</span>
            <strong class="value" [class.alarming]="tile.alarming">{{ tile.value | number }}</strong>
            <span class="detail">{{ tile.detail }}</span>
          </a>
        }
      </div>

      <div class="charts fx-gap-6 fx-mb-6">
        <wt-volume-chart
          [points]="(spans$ | async) ?? []"
          title="Spans"
          [unit]="'per ' + range.bucketLabel"
        />
        <wt-volume-chart
          [points]="(logs$ | async) ?? []"
          title="Log records"
          [unit]="'per ' + range.bucketLabel"
        />
      </div>
    }

    @if (servicesLoading$ | async) {
      <p class="hint">Loading services…</p>
    }

    <table id="services">
      <caption class="sr-only">Services reporting telemetry</caption>
      <thead>
        <tr>
          <th scope="col">Service</th>
          <th scope="col">Spans</th>
          <th scope="col">Logs</th>
          <th scope="col">Metrics</th>
          <th scope="col">Last seen</th>
          <th scope="col"><span class="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        @for (service of services$ | async; track service.ServiceName) {
          <tr>
            <th scope="row" class="mono">{{ service.ServiceName }}</th>
            <td>{{ service.traces | number }}</td>
            <td>{{ service.logs | number }}</td>
            <td>{{ service.metrics | number }}</td>
            <td>{{ service.lastSeen | date: 'medium' }}</td>
            <td class="fx-flex fx-gap-3">
              <a [routerLink]="['/traces']" [queryParams]="{ service: service.ServiceName }">traces</a>
              <a [routerLink]="['/logs']" [queryParams]="{ service: service.ServiceName }">logs</a>
              @if (service.metrics) {
                <a [routerLink]="['/metrics']">metrics</a>
              }
            </td>
          </tr>
        } @empty {
          <tr><td colspan="6" class="hint">Nothing has reported yet.</td></tr>
        }
      </tbody>
    </table>
  `,
  styles: `
    /* Only what the utility set does not express. Layout and spacing are in the
       template; these are colour, borders, and two intrinsic grids —
       auto-fit/minmax has no utility because the column count is decided by the
       container rather than chosen. */
    .tiles {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    }

    .charts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(28rem, 1fr));
    }

    .grouping {
      display: flex;
      align-items: center;
      gap: var(--fx-3xs);
      color: var(--text-dim);
      font-size: var(--fx-typography--1);
    }


    .tile {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--surface);
      color: inherit;
      text-decoration: none;
      transition:
        border-color 0.12s ease,
        background 0.12s ease;
    }

    .tile:hover,
    .tile:focus-visible {
      border-color: var(--accent);
      background: var(--surface-raised);
    }

    .tile .label {
      color: var(--text-dim);
      font-size: var(--fx-typography--1);
    }

    .tile .value {
      font-size: var(--fx-typography-4);
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      line-height: 1.1;
    }

    .tile .value.alarming {
      color: var(--error);
    }

    .tile .detail {
      color: var(--text-dim);
      font-size: var(--fx-typography--2);
    }

    .hint {
      color: var(--text-dim);
    }
  `,
})
export class ServicesView implements OnInit {
  private readonly store = inject(ServicesStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly ranges = RANGES;

  protected readonly services$ = this.store.services$;
  protected readonly range$ = this.store.range$;
  /** The chart speaks long-form series, so each signal is projected into that
   * shape rather than the chart knowing what a span is. */
  private readonly asSeries = (metric: 'spans' | 'logs') =>
    this.store.volume$.pipe(
      map((points) =>
        points.map((point) => ({
          bucket: point.bucket,
          series: point.ServiceName,
          value: point[metric],
        })),
      ),
    );

  protected readonly spans$ = this.asSeries('spans');
  protected readonly logs$ = this.asSeries('logs');
  protected readonly points$ = this.store.volume$;
  protected readonly grouping$ = this.store.grouping$;
  protected readonly groupings$ = this.store.groupings$;

  /**
   * Headline numbers for the window. These are the questions asked often enough
   * that they should not need a chart read: how much is arriving, from how many
   * services, and how much of it is bad.
   */
  protected readonly tiles$ = combineLatest([this.points$, this.range$]).pipe(
    map(([points, range]) => {
      const spans = points.reduce((sum, point) => sum + point.spans, 0);
      const logs = points.reduce((sum, point) => sum + point.logs, 0);
      const errors = points.reduce((sum, point) => sum + point.errors, 0);
      const services = new Set(points.map((point) => point.ServiceName)).size;

      // Every tile leads somewhere: a number worth showing is a number someone
      // will want to look behind.
      return [
        {
          label: 'Spans',
          value: spans,
          detail: `last ${range.label}`,
          alarming: false,
          link: ['/traces'],
          params: {},
          fragment: undefined,
        },
        {
          label: 'Log records',
          value: logs,
          detail: `last ${range.label}`,
          alarming: false,
          link: ['/logs'],
          params: {},
          fragment: undefined,
        },
        {
          label: 'Errors',
          value: errors,
          detail:
            spans + logs > 0 ? `${((errors / (spans + logs)) * 100).toFixed(1)}% of records` : '—',
          alarming: errors > 0,
          link: ['/traces'],
          params: { status: 'Error' },
          fragment: undefined,
        },
        {
          label: 'Services reporting',
          value: services,
          detail: `last ${range.label}`,
          alarming: false,
          // This one has no search behind it — the list it counts is the table
          // on this page, so it goes there rather than somewhere adjacent.
          link: [],
          params: {},
          fragment: 'services',
        },
      ];
    }),
  );

  /**
   * Per action rather than one flag for the view: the table and the charts are
   * fed by different requests, so changing the range should not blank the table
   * it has nothing to do with.
   *
   * `startWith` because `loading$` is a Subject — it reports transitions, and a
   * late subscriber has not seen one yet.
   */
  protected readonly servicesLoading$ = this.store
    .getLoadingFor('loadServices')
    .pipe(startWith(false));

  protected readonly volumeLoading$ = this.store
    .getLoadingFor('loadVolume')
    .pipe(startWith(false));

  constructor() {
    /**
     * The URL is the source of truth for the range, so a link carries the view
     * it was shared from. The flow is one-directional: a click only navigates,
     * and the range reaches the store from the URL — never both, which is what
     * would otherwise fight itself on the back button.
     */
    this.route.queryParamMap
      .pipe(
        map((params) => RANGES.find((range) => range.label === params.get('range'))),
        withLatestFrom(this.range$),
        // A missing or unknown param leaves the store's range alone; so does one
        // that already matches, which is what stops entering the page from
        // refetching what the store just loaded.
        filter(([fromUrl, current]) => Boolean(fromUrl) && fromUrl !== current),
        map(([fromUrl]) => fromUrl as Range),
        takeUntilDestroyed(),
      )
      .subscribe((range) => this.store.dispatch('selectRange', range));
  }

  ngOnInit(): void {
    this.store.dispatch('loadServices');
    this.store.dispatch('loadGroupings');

    // A link that names no range gets the default written into it, so the URL
    // always says what is on screen and is always worth copying.
    if (!this.route.snapshot.queryParamMap.has('range')) {
      this.select(DEFAULT_RANGE);
    }
  }

  protected selectGrouping(key: string): void {
    this.store.dispatch('selectGrouping', key);
  }

  protected select(range: Range): void {
    // `replaceUrl` because choosing a window is refining one view rather than
    // moving to another; the back button should leave the page, not step
    // through every range you tried.
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { range: range.label },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
