import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AsyncPipe, DecimalPipe, PercentPipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map, skip, startWith } from 'rxjs';

import { AppScope } from '../../core/app-scope';
import { OperationSort, OperationsStore } from '../../core/operations.store';
import { RANGES, Range } from '../../core/services.store';
import { PageHeader } from '../../shared/page-header';
import { DurationPipe } from '../../shared/duration-pipe';

const KINDS = ['Server', 'Client', 'Internal', 'Producer', 'Consumer'];

@Component({
  selector: 'wt-operations-view',
  imports: [
    AsyncPipe,
    DecimalPipe,
    PercentPipe,
    DurationPipe,
    ReactiveFormsModule,
    RouterLink,
    PageHeader,
    MatButtonModule,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <wt-page-header
      heading="Operations"
      subtitle="How often each one runs, how often it fails, and how long it takes — read from the spans, not from a metric anyone had to remember to emit."
    >
      <mat-button-toggle-group
        aria-label="Time range"
        hideSingleSelectionIndicator
        [value]="(range$ | async)?.label"
      >
        @for (option of ranges; track option.label) {
          <mat-button-toggle [value]="option.label" (click)="selectRange(option)">
            {{ option.label }}
          </mat-button-toggle>
        }
      </mat-button-toggle-group>
    </wt-page-header>

    <form [formGroup]="filters" (ngSubmit)="run()" class="filters fx-flex fx-flex-wrap fx-items-end fx-gap-3 fx-mb-4">
      <mat-form-field subscriptSizing="dynamic">
        <mat-label>Service</mat-label>
        <input matInput formControlName="service" placeholder="any" class="mono" />
      </mat-form-field>

      <mat-form-field subscriptSizing="dynamic" class="narrow">
        <mat-label>Kind</mat-label>
        <mat-select formControlName="kind">
          <!-- Not filtered to Server by default, which is the textbook way to
               read RED: a browser emits Client and Internal spans and nothing
               else, so that default reports an empty page for the one service
               every user actually touches. -->
          <mat-option value="">any</mat-option>
          @for (kind of kinds; track kind) {
            <mat-option [value]="kind">{{ kind }}</mat-option>
          }
        </mat-select>
      </mat-form-field>

      <mat-form-field subscriptSizing="dynamic" class="narrow">
        <mat-label>Group</mat-label>
        <mat-select formControlName="by">
          <mat-option value="operation">Operation</mat-option>
          <mat-option value="service">Service</mat-option>
        </mat-select>
      </mat-form-field>

      <button mat-flat-button type="submit">Apply</button>
    </form>

    <p class="status" aria-live="polite">
      {{ (rows$ | async)?.length ?? 0 }} rows{{ (loading$ | async) ? ' — loading…' : '' }}
    </p>

    <table>
      <caption class="sr-only">Operations by rate, errors and duration</caption>
      <thead>
        <tr>
          <th scope="col">Service</th>
          @if ((query$ | async)?.by === 'operation') {
            <th scope="col">Operation</th>
          }
          <th scope="col">Kinds</th>
          <!-- Sorting is the server's job: the ranking is of everything in the
               window, and a column sorted in the browser can only reorder the
               two hundred rows it was given. -->
          @for (column of columns; track column.sort) {
            <th scope="col" class="num">
              <button
                type="button"
                class="sort"
                [class.current]="(query$ | async)?.sort === column.sort"
                (click)="sortBy(column.sort)"
              >
                {{ column.label }}
              </button>
            </th>
          }
          <th scope="col"><span class="sr-only">Traces</span></th>
        </tr>
      </thead>
      <tbody>
        @for (row of rows$ | async; track row.ServiceName + '|' + row.SpanName) {
          <tr>
            <th scope="row" class="mono">{{ row.ServiceName }}</th>
            @if (row.SpanName) {
              <td class="mono name">{{ row.SpanName }}</td>
            }
            <td class="dim">{{ row.kinds }}</td>
            <td class="num">{{ row.calls | number }}</td>
            <td class="num" [class.bad]="row.errors > 0">
              {{ row.errors | number }}
              @if (row.errors > 0) {
                <span class="rate">{{ row.errors / row.calls | percent: '1.0-1' }}</span>
              }
            </td>
            <td class="num">{{ row.p50Ms * 1e6 | duration }}</td>
            <td class="num">{{ row.p95Ms * 1e6 | duration }}</td>
            <td class="num">{{ row.p99Ms * 1e6 | duration }}</td>
            <td class="num dim">{{ row.maxMs * 1e6 | duration }}</td>
            <td>
              <a
                [routerLink]="scope.link('traces')"
                [queryParams]="traceLink(row)"
              >traces</a>
            </td>
          </tr>
        } @empty {
          @if ((loading$ | async) === false) {
            <tr>
              <td colspan="9" class="hint">
                Nothing ran in this window — widen it, or drop the service filter.
              </td>
            </tr>
          }
        }
      </tbody>
    </table>
  `,
  styles: `
    .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    .name {
      max-width: 28rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .bad {
      color: var(--error);
    }

    .rate {
      margin-inline-start: var(--fx-3xs);
      font-size: var(--fx-typography--2);
      opacity: 0.8;
    }

    .sort {
      appearance: none;
      border: 0;
      background: none;
      padding: 0;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }

    .sort:hover {
      color: var(--text);
    }

    .sort.current {
      color: var(--accent);
    }

    .status {
      color: var(--text-dim);
      font-size: var(--fx-typography--1);
    }

    .narrow {
      width: 9rem;
    }
  `,
})
export class OperationsView implements OnInit {
  private readonly store = inject(OperationsStore);
  protected readonly scope = inject(AppScope);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly ranges = RANGES;
  protected readonly kinds = KINDS;
  protected readonly columns: { label: string; sort: OperationSort }[] = [
    { label: 'Calls', sort: 'calls' },
    { label: 'Errors', sort: 'errors' },
    { label: 'p50', sort: 'p50' },
    { label: 'p95', sort: 'p95' },
    { label: 'p99', sort: 'p99' },
    { label: 'max', sort: 'max' },
  ];

  protected readonly filters = new FormGroup({
    // Seeded from the URL so the overview can link here already scoped to one
    // service.
    service: new FormControl(this.route.snapshot.queryParamMap.get('service') ?? ''),
    kind: new FormControl(this.route.snapshot.queryParamMap.get('kind') ?? ''),
    by: new FormControl(this.route.snapshot.queryParamMap.get('by') ?? 'operation'),
  });

  protected readonly rows$ = this.store.rows$;
  protected readonly query$ = this.store.query$;
  protected readonly range$ = this.store.query$.pipe(map((query) => query.range));
  protected readonly loading$ = this.store.getLoadingFor('load').pipe(startWith(false));

  constructor() {
    // Switching app changes a path parameter and Angular reuses the component,
    // so nothing would re-run on its own. skip(1) because the first emission is
    // the scope this page loaded under.
    this.scope.app$.pipe(skip(1), takeUntilDestroyed()).subscribe(() => this.run());
  }

  ngOnInit(): void {
    const range = RANGES.find(
      (option) => option.label === this.route.snapshot.queryParamMap.get('range'),
    );

    this.run(range ? { range } : {});
  }

  protected selectRange(range: Range): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { range: range.label },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    this.run({ range });
  }

  protected sortBy(sort: OperationSort): void {
    this.run({ sort });
  }

  protected traceLink(row: { ServiceName: string; SpanName: string }): Record<string, string> {
    return row.SpanName
      ? { service: row.ServiceName, name: row.SpanName }
      : { service: row.ServiceName };
  }

  protected run(changes: Record<string, unknown> = {}): void {
    const { service, kind, by } = this.filters.getRawValue();
    const merged = { service: service ?? '', kind: kind ?? '', by: by as 'service' | 'operation', ...changes };

    // Recorded before the request rather than after it, so the controls and the
    // rows can never describe different queries.
    this.store.dispatch('apply', merged);
    this.store.dispatch('load', merged);
  }
}
