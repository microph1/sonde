import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { AsyncPipe, DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { combineLatest, filter, map, startWith, withLatestFrom, skip } from 'rxjs';

import { AppScope } from '../../core/app-scope';
import { DEFAULT_RANGE, Range, ServicesStore } from '../../core/services.store';
import { bucketOf, describe, fromParams, sameRange, toParams } from '../../core/time-range';
import { OperationsStore } from '../../core/operations.store';
import { DurationPipe } from '../../shared/duration-pipe';
import { PageHeader } from '../../shared/page-header';
import { TimeRangePicker } from '../../shared/time-range-picker';
import { VolumeChart } from '../../shared/volume-chart';

@Component({
  selector: 'wt-services-view',
  imports: [
    RouterLink,
    AsyncPipe,
    DatePipe,
    DecimalPipe,
    PercentPipe,
    DurationPipe,
    VolumeChart,

    MatFormFieldModule,
    MatSelectModule, PageHeader, TimeRangePicker],
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

        <wt-time-range />
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
          [unit]="'per ' + bucket(range)"
        />
        <wt-volume-chart
          [points]="(logs$ | async) ?? []"
          title="Log records"
          [unit]="'per ' + bucket(range)"
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
          <!-- Over the selected window, unlike the counts beside them, which
               are for the whole of retention. A latency averaged over all time
               would flatten away every incident it exists to show. -->
          <th scope="col" class="num">p50</th>
          <th scope="col" class="num">p95</th>
          <th scope="col" class="num">Errors</th>
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
            @if ((latency$ | async)?.[service.ServiceName]; as red) {
              <td class="num">{{ red.p50Ms * 1e6 | duration }}</td>
              <td class="num">{{ red.p95Ms * 1e6 | duration }}</td>
              <td class="num" [class.alarming]="red.errors > 0">
                {{ red.errors ? (red.errors / red.calls | percent: '1.0-1') : '—' }}
              </td>
            } @else {
              <!-- A service that sent no spans in this window has no latency,
                   which is different from a latency of zero. -->
              <td class="num dim">—</td>
              <td class="num dim">—</td>
              <td class="num dim">—</td>
            }
            <td>{{ service.lastSeen | date: 'medium' }}</td>
            <td class="fx-flex fx-gap-3">
              <a [routerLink]="scope.link('traces')" [queryParams]="{ service: service.ServiceName }">traces</a>
              <a [routerLink]="scope.link('operations')" [queryParams]="{ service: service.ServiceName }">operations</a>
              <a [routerLink]="scope.link('logs')" [queryParams]="{ service: service.ServiceName }">logs</a>
              @if (service.metrics) {
                <a [routerLink]="scope.link('metrics')">metrics</a>
              }
            </td>
          </tr>
        } @empty {
          <tr><td colspan="9" class="hint">Nothing has reported yet.</td></tr>
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
  private readonly operations = inject(OperationsStore);
  protected readonly scope = inject(AppScope);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);


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
      const spanErrors = points.reduce((sum, point) => sum + point.spanErrors, 0);
      const logErrors = points.reduce((sum, point) => sum + point.logErrors, 0);
      const services = new Set(points.map((point) => point.ServiceName)).size;

      // Every tile leads somewhere: a number worth showing is a number someone
      // will want to look behind.
      return [
        {
          label: 'Spans',
          value: spans,
          detail: describe(range),
          alarming: false,
          link: this.scope.link('traces'),
          params: {},
          fragment: undefined,
        },
        {
          label: 'Log records',
          value: logs,
          detail: describe(range),
          alarming: false,
          link: this.scope.link('logs'),
          params: {},
          fragment: undefined,
        },
        {
          label: 'Errors',
          value: errors,
          // Which signal they came from, because the number counts both and the
          // link can only go to one. A window whose errors are all log records
          // sent you to Traces filtered to Error, which is empty by definition —
          // a tile reading 8 and a page reading 0, with nothing to say why.
          detail: errorDetail(errors, spanErrors, logErrors, spans + logs),
          alarming: errors > 0,
          link: this.scope.link(spanErrors > 0 ? 'traces' : 'logs'),
          params: spanErrors > 0 ? { status: 'Error' } : { minSeverity: 17 },
          fragment: undefined,
        },
        {
          label: 'Services reporting',
          value: services,
          detail: describe(range),
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

  /**
   * Latency and error rate per service, keyed by name for the table to look up.
   *
   * From the operations store because it is the same question at a coarser
   * grouping, and asking it twice would mean two queries that could disagree.
   * Keyed rather than joined row by row: the services list is all of retention
   * and this is one window, so the two are different sets and a positional
   * join would quietly pair the wrong rows.
   */
  protected readonly latency$ = this.operations.rows$.pipe(
    map((rows) => Object.fromEntries(rows.map((row) => [row.ServiceName, row]))),
  );

  constructor() {
    /**
     * The URL is the source of truth for the range, so a link carries the view
     * it was shared from. The flow is one-directional: a click only navigates,
     * and the range reaches the store from the URL — never both, which is what
     * would otherwise fight itself on the back button.
     */
    this.route.queryParamMap
      .pipe(
        map((params) => fromParams(params)),
        withLatestFrom(this.range$),
        // A URL that names no window leaves the store alone; so does one that
        // already matches, which stops entering the page from refetching what
        // the store just loaded.
        filter(([fromUrl, current]) => Boolean(fromUrl) && !sameRange(fromUrl, current)),
        map(([fromUrl]) => fromUrl as Range),
        takeUntilDestroyed(),
      )
      .subscribe((range) => this.store.dispatch('selectRange', range));

    // Switching app changes a path parameter, and Angular reuses the component
    // rather than recreating it — so nothing would re-run on its own. skip(1)
    // because the first emission is the scope this page just loaded under.
    this.scope.app$
      .pipe(skip(1), withLatestFrom(this.range$, this.grouping$), takeUntilDestroyed())
      .subscribe(([, range, grouping]) => {
        this.store.dispatch('loadServices');
        this.store.dispatch('loadVolume', { range, grouping });
      });

    // The table's latency columns are of the selected window, so they reload
    // with it — including the first emission, which is what fills them on
    // arrival.
    this.range$
      .pipe(takeUntilDestroyed())
      .subscribe((range) =>
        this.operations.dispatch('load', { by: 'service', range, service: '', kind: '' }),
      );
  }

  ngOnInit(): void {
    this.store.dispatch('loadServices');
    this.store.dispatch('loadGroupings');

    // A link that names no window gets the default written into it, so the URL
    // always says what is on screen and is always worth copying.
    if (!fromParams(this.route.snapshot.queryParamMap)) {
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: toParams(DEFAULT_RANGE),
        queryParamsHandling: 'merge',
        // Refining one view rather than moving to another: the back button
        // should leave the page, not step through every window you tried.
        replaceUrl: true,
      });
    }
  }

  /** The bucket the chart's points were aggregated into, named for the axis. */
  protected bucket(range: Range): string {
    return bucketOf(range).label;
  }

  protected selectGrouping(key: string): void {
    this.store.dispatch('selectGrouping', key);
  }
}

/**
 * What the error count is made of.
 *
 * Two signals can report an error and they are counted together, so the tile
 * says which kind it found rather than leaving the share of records to imply
 * it — the share is the same number whether the errors were spans or logs, and
 * only one of those is where the link goes.
 */
function errorDetail(
  errors: number,
  spanErrors: number,
  logErrors: number,
  records: number,
): string {
  if (errors === 0) {
    return records > 0 ? 'none' : '—';
  }

  const share = records > 0 ? `${((errors / records) * 100).toFixed(1)}% of records` : '';
  const kind =
    spanErrors > 0 && logErrors > 0
      ? `${spanErrors} in spans, ${logErrors} in logs`
      : spanErrors > 0
        ? 'in spans'
        : 'in logs';

  return share ? `${kind} · ${share}` : kind;
}
