import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { AsyncPipe, DatePipe } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatExpansionModule } from '@angular/material/expansion';
import { PageHeader } from '../../shared/page-header';
import { TraceDetail } from '../trace-detail/trace-detail';
import { BehaviorSubject, map, startWith } from 'rxjs';

import { TracesStore } from '../../core/traces.store';
import { DEFAULT_RANGE, RANGES, Range } from '../../core/services.store';
import { TraceFilters } from '../../core/telemetry.model';
import { DurationPipe } from '../../shared/duration-pipe';

@Component({
  selector: 'wt-traces-view',
  imports: [ReactiveFormsModule, RouterLink, AsyncPipe, DatePipe, DurationPipe, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatIconModule, PageHeader, MatButtonToggleModule, MatExpansionModule, TraceDetail],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <wt-page-header
        heading="Traces"
        subtitle="Spans as they were recorded. Search a window, or tail what is arriving now."
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

        <mat-form-field subscriptSizing="dynamic">
          <mat-label>Span name</mat-label>
          <input matInput formControlName="name" placeholder="any" class="mono" />
        </mat-form-field>

        <mat-form-field subscriptSizing="dynamic" class="narrow">
          <mat-label>Status</mat-label>
          <mat-select formControlName="status">
            <mat-option value="">any</mat-option>
            <mat-option value="Ok">Ok</mat-option>
            <mat-option value="Error">Error</mat-option>
            <mat-option value="Unset">Unset</mat-option>
          </mat-select>
        </mat-form-field>

        <mat-form-field subscriptSizing="dynamic" class="narrow">
          <mat-label>Slower than</mat-label>
          <input matInput formControlName="minDurationMs" type="number" min="0" />
          <span matTextSuffix>ms</span>
        </mat-form-field>

        <mat-form-field subscriptSizing="dynamic" class="narrow">
          <mat-label>Limit</mat-label>
          <input matInput formControlName="limit" type="number" min="1" />
        </mat-form-field>

        <button mat-flat-button type="submit" [disabled]="(live$ | async) ?? false">
          <mat-icon>search</mat-icon>
          Search
        </button>

        @if ((live$ | async) === true) {
          <button mat-stroked-button type="button" (click)="stop()">
            <mat-icon>stop</mat-icon>
            Stop tail
          </button>
        } @else {
          <button mat-stroked-button type="button" (click)="startLive()">
            <mat-icon>bolt</mat-icon>
            Live tail
          </button>
        }
      </form>

      <p class="status fx-flex fx-items-center fx-gap-2" aria-live="polite">
        @if ((live$ | async) === true) {
          <span class="pill">live</span>
        }
        {{ (rows$ | async)?.length ?? 0 }} spans{{ (searching$ | async) ? ' — streaming…' : '' }}
      </p>

    <!-- A list of expansion panels rather than a table: a row that opens
           in place keeps the search, the scroll position and the row you
           were looking at, which navigating to a page of its own did not.
           The strip above carries the column names the panel headers line
           up with. -->
    <div class="columns" aria-hidden="true">
        <span>Time</span>
        <span>Service</span>
        <span>Span</span>
        <span>Kind</span>
        <span class="num">Duration</span>
        <span>Status</span>
      </div>

    <mat-accordion class="spans" displayMode="flat">
        @for (span of rows$ | async; track span.SpanId) {
          <mat-expansion-panel
              [expanded]="span.TraceId === initialTrace"
            (opened)="open(span.TraceId)"
            hideToggle
          >
            <mat-expansion-panel-header>
              <mat-panel-title>
                <span class="cell when">{{ span.Timestamp | date: 'HH:mm:ss.SSS' }}</span>
                <span class="cell mono">{{ span.ServiceName }}</span>
                <span class="cell name" [title]="span.SpanName">{{ span.SpanName }}</span>
                <span class="cell dim">{{ span.SpanKind }}</span>
                <span class="cell num">{{ span.Duration | duration }}</span>
                <span class="cell">
                  <span class="chip" [class]="'chip status-' + span.StatusCode">{{ span.StatusCode }}</span>
                </span>
              </mat-panel-title>
            </mat-expansion-panel-header>

            <!-- Rendered only once open: every panel sharing one trace store
                 means only the expanded one may exist. -->
            <ng-template matExpansionPanelContent>
              <wt-trace-detail [traceId]="span.TraceId" />
            </ng-template>
          </mat-expansion-panel>
        } @empty {
          @if (!(searching$ | async)) {
            <div class="nothing-here">
              <mat-icon>account_tree</mat-icon>
              <span>No spans matched. Widen the window, drop the duration filter, or tail what is arriving.</span>
            </div>
          }
        }
    </mat-accordion>
  `,
  styles: `
    /* The strip and the panel headers share one column template, so the labels
       sit over the values they name. */
    .columns,
    mat-panel-title {
      display: grid;
      grid-template-columns: 7rem 12rem minmax(0, 1fr) 6rem 6rem 6rem;
      align-items: center;
      gap: var(--fx-s);
    }

    .columns {
      padding: var(--fx-2xs) var(--fx-s);
      color: var(--text-dim);
      font-size: var(--fx-typography--1);
      letter-spacing: 0.02em;
    }

    .spans {
      display: block;
      border: 1px solid var(--line);
      border-radius: var(--mat-sys-corner-medium);
      overflow: hidden;
    }

    mat-expansion-panel {
      border-radius: 0 !important;
      border-bottom: 1px solid var(--line);
    }

    .cell {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .when {
      font-variant-numeric: tabular-nums;
    }

    .name {
      color: var(--text);
    }

    .filters mat-form-field {
      min-width: 12rem;
    }

    .filters mat-form-field.narrow {
      min-width: 7.5rem;
    }

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
  private readonly router = inject(Router);

  protected readonly filters = new FormGroup({
    // Seeded from the URL so a link can carry a filtered view — the overview's
    // tiles arrive here with one already applied.
    service: new FormControl(this.route.snapshot.queryParamMap.get('service') ?? ''),
    name: new FormControl(this.route.snapshot.queryParamMap.get('name') ?? ''),
    status: new FormControl(this.route.snapshot.queryParamMap.get('status') ?? ''),
    minDurationMs: new FormControl<number | null>(null),
    limit: new FormControl(200),
  });

  /**
   * The trace a link arrived with, read once.
   *
   * Read once rather than bound to the route, because Material owns whether a
   * panel is open and a live binding fights it: the accordion closes the
   * previous panel when another opens, the close rewrites the URL, the URL
   * rewrites the binding, and the row that was just opened collapses again.
   * The URL follows the opening; it does not drive it.
   */
  protected readonly initialTrace = this.route.snapshot.firstChild?.paramMap.get('traceId') ?? '';

  protected readonly ranges = RANGES;

  /** The window to search. In the URL because a link to "what happened" is
   * worthless without the when, and in a subject because the search reads it
   * at dispatch time rather than subscribing to it. */
  private readonly chosen$$ = new BehaviorSubject<Range>(
    RANGES.find((option) => option.label === this.route.snapshot.queryParamMap.get('range')) ??
      DEFAULT_RANGE,
  );

  protected readonly range$ = this.chosen$$.asObservable();

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

  protected selectRange(range: Range): void {
    this.chosen$$.next(range);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { range: range.label },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    this.run();
  }

  /**
   * Opening a row loads its trace. That is all it does.
   *
   * An earlier version also wrote the open row into the URL and read it back,
   * which put two owners on one piece of state: Material closes the previous
   * panel when another opens, that close rewrote the URL, and the URL rewrote
   * the panel that had just been opened. Expansion is UI state and Material
   * owns it; the URL still opens a row on arrival, and no longer argues about
   * it afterwards.
   */
  protected open(traceId: string): void {
    this.store.dispatch('loadTrace', traceId);
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
    const range = this.chosen$$.value;

    return {
      service: service ?? '',
      name: name ?? '',
      status: status ?? '',
      minDurationMs: minDurationMs ?? 0,
      limit: limit ?? 200,
      // Without this the API applied its own one-hour default and the page had
      // no way to say otherwise: anything older than an hour simply was not
      // there, and the empty state told you to widen a window you could not
      // reach.
      from: new Date(Date.now() - range.windowMinutes * 60_000).toISOString(),
    };
  }
}
