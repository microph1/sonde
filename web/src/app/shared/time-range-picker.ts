import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AsyncPipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { BehaviorSubject, Observable, distinctUntilChanged, map } from 'rxjs';

import {
  DEFAULT_RANGE,
  RANGES,
  Relative,
  TimeRange,
  describe,
  fromParams,
  sameRange,
  toParams,
} from '../core/time-range';

/**
 * The window control, shared by every page that has one.
 *
 * The URL owns the range: a view of a moment is worth nothing if you cannot
 * send it to someone, and the back button has to walk back through time as
 * well as through pages. So this writes to the URL and reads its own state
 * back from it, rather than keeping a copy that could disagree.
 */
@Component({
  selector: 'wt-time-range',
  imports: [
    AsyncPipe,
    ReactiveFormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatMenuModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="picker fx-flex fx-items-center fx-gap-2">
      <mat-button-toggle-group
        aria-label="Time range"
        hideSingleSelectionIndicator
        [value]="(label$ | async) ?? ''"
      >
        @for (option of ranges; track option.label) {
          <mat-button-toggle [value]="option.label" (click)="choose(option)">
            {{ option.label }}
          </mat-button-toggle>
        }
      </mat-button-toggle-group>

      <button
        mat-stroked-button
        class="custom"
        [class.active]="(absolute$ | async) === true"
        [matMenuTriggerFor]="menu"
        (menuOpened)="seed()"
      >
        <mat-icon>date_range</mat-icon>
        {{ (custom$ | async) ?? 'Custom' }}
      </button>

      <mat-menu #menu="matMenu" class="range-menu">
        <!-- Stops a click inside the form from closing the menu, which it
             otherwise does on the way to the first field. -->
        <form [formGroup]="window" (click)="$event.stopPropagation()" (ngSubmit)="apply()" class="fx-grid fx-gap-2 fx-p-3">
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>From</mat-label>
            <input matInput type="datetime-local" step="1" formControlName="from" />
          </mat-form-field>

          <mat-form-field subscriptSizing="dynamic">
            <mat-label>To</mat-label>
            <input matInput type="datetime-local" step="1" formControlName="to" />
          </mat-form-field>

          <div class="fx-flex fx-gap-2 fx-items-center">
            <button mat-flat-button type="submit" [disabled]="(valid$ | async) === false">Apply</button>
            <span class="dim error" aria-live="polite">{{ (problem$ | async) ?? '' }}</span>
          </div>
        </form>
      </mat-menu>
    </div>
  `,
  styles: `
    .custom.active {
      border-color: var(--accent);
      color: var(--accent);
    }

    .custom mat-icon {
      margin-inline-end: var(--fx-3xs);
      font-size: 1.1rem;
      width: 1.1rem;
      height: 1.1rem;
    }

    form {
      min-width: 17rem;
    }

    .error {
      font-size: var(--fx-typography--1);
      color: var(--error);
    }
  `,
})
export class TimeRangePicker {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly ranges = RANGES;

  /** The range the URL names, which is the only place it is kept. */
  readonly range$: Observable<TimeRange> = this.route.queryParamMap.pipe(
    map((params): TimeRange => fromParams(params) ?? DEFAULT_RANGE),
    distinctUntilChanged((a: TimeRange, b: TimeRange) => sameRange(a, b)),
  );

  protected readonly label$ = this.range$.pipe(
    map((range) => (range.kind === 'relative' ? range.label : '')),
  );

  protected readonly absolute$ = this.range$.pipe(map((range) => range.kind === 'absolute'));
  protected readonly custom$ = this.range$.pipe(
    map((range) => (range.kind === 'absolute' ? describe(range) : 'Custom')),
  );

  protected readonly window = new FormGroup({
    from: new FormControl(''),
    to: new FormControl(''),
  });

  private readonly problem$$ = new BehaviorSubject<string>('');

  protected readonly problem$ = this.problem$$.asObservable();
  protected readonly valid$ = this.window.valueChanges.pipe(
    map(({ from, to }) => Boolean(from && to)),
  );

  constructor() {
    // Clearing the message when the fields change keeps it tied to the attempt
    // that produced it.
    this.window.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => this.problem$$.next(''));
  }

  protected choose(option: Relative): void {
    this.write(option);
  }

  /** Opens the form on whatever window is on screen, so narrowing an hour is
   * an edit rather than two timestamps typed from nothing. */
  protected seed(): void {
    const params = this.route.snapshot.queryParamMap;
    const range = fromParams(params) ?? DEFAULT_RANGE;
    const now = Date.now();
    const from =
      range.kind === 'absolute' ? Date.parse(range.from) : now - range.minutes * 60_000;
    const to = range.kind === 'absolute' ? Date.parse(range.to) : now;

    this.window.setValue({ from: local(from), to: local(to) }, { emitEvent: false });
    this.problem$$.next('');
  }

  protected apply(): void {
    const { from, to } = this.window.getRawValue();
    const start = Date.parse(from ?? '');
    const end = Date.parse(to ?? '');

    if (Number.isNaN(start) || Number.isNaN(end)) {
      this.problem$$.next('Both ends are needed.');
      return;
    }

    // Refused rather than swapped: a window typed backwards is as likely to be
    // the wrong day as the wrong order, and silently fixing it would show a
    // window nobody asked for.
    if (end <= start) {
      this.problem$$.next('The end has to come after the start.');
      return;
    }

    this.write({ kind: 'absolute', from: new Date(start).toISOString(), to: new Date(end).toISOString() });
  }

  private write(range: TimeRange): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: toParams(range),
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}

/** `datetime-local` speaks local wall-clock with no zone, which is what a
 * person typing a time means. */
function local(epochMs: number): string {
  const date = new Date(epochMs - new Date().getTimezoneOffset() * 60_000);

  return date.toISOString().slice(0, 19);
}
