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
import { PageHeader } from '../../shared/page-header';
import { BehaviorSubject, startWith } from 'rxjs';

import { LogsStore } from '../../core/logs.store';
import { DEFAULT_RANGE, RANGES, Range } from '../../core/services.store';
import { LogFilters, LogRecord } from '../../core/telemetry.model';

/** How much of a record's fields fits on one line before it stops being a
 * summary and starts being the thing you expand the row for. */
/* eslint-disable no-control-regex -- matching control characters is the point. */
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;

const SUMMARY_FIELDS = 3;
const SUMMARY_CHARS = 70;

@Component({
  selector: 'wt-logs-view',
  imports: [ReactiveFormsModule, RouterLink, AsyncPipe, DatePipe, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatIconModule, PageHeader, MatButtonToggleModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <wt-page-header
      heading="Logs"
      subtitle="Records with the fields their instrumentation attached. Expand a row for the whole set."
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

      <mat-form-field subscriptSizing="dynamic" class="wide">
        <mat-label>Body contains</mat-label>
        <input matInput formControlName="contains" placeholder="any" />
      </mat-form-field>

      <mat-form-field subscriptSizing="dynamic">
        <mat-label>Scope</mat-label>
        <input matInput formControlName="scope" placeholder="any" class="mono" />
      </mat-form-field>

      <mat-form-field subscriptSizing="dynamic">
        <mat-label>Minimum severity</mat-label>
        <mat-select formControlName="minSeverity">
          <mat-option [value]="0">any</mat-option>
          <mat-option [value]="5">DEBUG</mat-option>
          <mat-option [value]="9">INFO</mat-option>
          <mat-option [value]="13">WARN</mat-option>
          <mat-option [value]="17">ERROR</mat-option>
        </mat-select>
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
      {{ (rows$ | async)?.length ?? 0 }} records{{ (searching$ | async) ? ' — streaming…' : '' }}
    </p>

    <table>
      <caption class="sr-only">Matching log records</caption>
      <thead>
        <tr>
          <th scope="col"><span class="sr-only">Expand</span></th>
          <th scope="col">Time</th>
          <th scope="col">Service</th>
          <th scope="col">Severity</th>
          <th scope="col">Scope</th>
          <th scope="col">Message</th>
          <th scope="col">Trace</th>
        </tr>
      </thead>
      <tbody>
        @for (record of rows$ | async; track $index) {
          <tr class="record" [class.open]="(expanded$ | async)?.has($index)">
            <td class="expander">
              @if (attributes(record).length) {
                <button
                  mat-icon-button
                  type="button"
                  [attr.aria-expanded]="(expanded$ | async)?.has($index) ?? false"
                  [attr.aria-label]="'Show the fields on this record'"
                  (click)="toggle($index)"
                >
                  <mat-icon>{{ (expanded$ | async)?.has($index) ? 'expand_more' : 'chevron_right' }}</mat-icon>
                </button>
              }
            </td>
            <td class="when">{{ record.Timestamp | date: 'HH:mm:ss.SSS' }}</td>
            <td class="mono">{{ record.ServiceName }}</td>
            <td>
              <span class="chip" [class]="'chip ' + severityClass(record.SeverityNumber)">
                {{ record.SeverityText || '—' }}
              </span>
            </td>
            <td class="mono dim scope">
              @if (record.ScopeName) {
                <button type="button" class="link" (click)="filterByScope(record.ScopeName)">
                  {{ record.ScopeName }}
                </button>
              }
            </td>
            <td class="body">
              {{ body(record) }}
              <!-- A terse message with its fields beside it. The tracing crate
                   writes info!(agent, protocol, "identify"), so the body alone is
                   a column of the same word and the record is in the fields. -->
              @if (summary(record); as fields) {
                <span class="fields dim">{{ fields }}</span>
              }
            </td>
            <td>
              @if (record.TraceId) {
                <a class="mono" [routerLink]="['/traces', record.TraceId]">{{ record.TraceId.slice(0, 12) }}…</a>
              }
            </td>
          </tr>

          @if ((expanded$ | async)?.has($index)) {
            <tr class="detail">
              <td></td>
              <td colspan="6">
                <dl>
                  @for (field of attributes(record); track field.key) {
                    <div>
                      <dt class="mono dim">{{ field.key }}</dt>
                      <dd class="mono">{{ field.value }}</dd>
                    </div>
                  }
                  @if (record.SpanId) {
                    <div>
                      <dt class="mono dim">span</dt>
                      <dd class="mono">{{ record.SpanId }}</dd>
                    </div>
                  }
                </dl>
              </td>
            </tr>
          }
        } @empty {
          @if (!(searching$ | async)) {
            <tr>
              <td colspan="7">
                <div class="nothing-here">
                  <mat-icon>subject</mat-icon>
                  <span>Nothing matched. Widen the severity, clear a filter, or tail what is arriving.</span>
                </div>
              </td>
            </tr>
          }
        }
      </tbody>
    </table>
  `,
  styles: `
    .filters mat-form-field {
      min-width: 11rem;
    }

    .filters mat-form-field.wide {
      min-width: 18rem;
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

    .body {
      font-family: ui-monospace, monospace;
      font-size: 0.9em;
      max-width: 60ch;
      overflow-wrap: anywhere;
    }

    .status {
      color: var(--text-dim);
    }

    .hint {
      color: var(--text-dim);
    }

    .sev-error {
      color: var(--error);
    }

    .sev-warn {
      color: var(--warn);
    }

    .sev-info {
      color: var(--text);
    }

    .sev-debug {
      color: var(--text-dim);
    }

    .expander {
      width: 2rem;
      padding-inline: 0;
    }

    .expander button {
      width: 1.75rem;
      height: 1.75rem;
      padding: 0;
    }

    .expander mat-icon {
      font-size: 1.1rem;
      width: 1.1rem;
      height: 1.1rem;
    }

    .when {
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }

    .scope {
      max-width: 22ch;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: var(--fx-typography--1);
    }

    .link {
      border: 0;
      padding: 0;
      background: none;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }

    .link:hover {
      color: var(--accent);
      text-decoration: underline;
    }

    .fields {
      margin-inline-start: var(--fx-2xs);
      font-size: var(--fx-typography--1);
    }

    tr.record.open {
      background: var(--surface);
    }

    tr.detail td {
      background: var(--surface);
      border-bottom: 1px solid var(--line);
    }

    tr.detail dl {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr);
      gap: 0.15rem var(--fx-s);
      margin: 0;
      padding-block: var(--fx-2xs);
    }

    tr.detail dl div {
      display: contents;
    }

    tr.detail dt,
    tr.detail dd {
      margin: 0;
      font-size: var(--fx-typography--1);
    }

    tr.detail dd {
      overflow-wrap: anywhere;
    }
  `,
})
export class LogsView implements OnInit {
  private readonly store = inject(LogsStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly filters = new FormGroup({
    service: new FormControl(this.route.snapshot.queryParamMap.get('service') ?? ''),
    contains: new FormControl(this.route.snapshot.queryParamMap.get('contains') ?? ''),
    scope: new FormControl(this.route.snapshot.queryParamMap.get('scope') ?? ''),
    minSeverity: new FormControl(Number(this.route.snapshot.queryParamMap.get('minSeverity') ?? 0)),
    limit: new FormControl(200),
  });

  /** Which rows are open. A set rather than one index: comparing two records
   * means having both of them expanded at once. */
  private readonly open$$ = new BehaviorSubject<ReadonlySet<number>>(new Set());

  protected readonly expanded$ = this.open$$.asObservable();
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

  protected run(): void {
    this.store.dispatch('search', this.currentFilters());
  }

  protected startLive(): void {
    this.store.dispatch('tail', this.currentFilters());
  }

  protected stop(): void {
    this.store.dispatch('stop');
  }

  protected toggle(index: number): void {
    const open = new Set(this.open$$.value);

    open.has(index) ? open.delete(index) : open.add(index);
    this.open$$.next(open);
  }

  /**
   * The fields on a record, which is where a Rust service puts the content.
   *
   * `tracing::info!(agent, protocol, "identify")` is the idiomatic way to write
   * that line: the message stays terse and everything that varies goes into
   * structured fields. A table that renders Body alone shows the same word over
   * and over and calls it a log.
   */
  protected attributes(record: LogRecord): { key: string; value: string }[] {
    const fields = Object.entries(record.LogAttributes ?? {}).map(([key, value]) => ({
      key,
      value: String(value),
    }));

    return record.ScopeName
      ? [{ key: 'scope', value: record.ScopeName }, ...fields]
      : fields;
  }

  /** Enough of the fields to tell two records apart without opening either. */
  protected summary(record: LogRecord): string {
    const fields = Object.entries(record.LogAttributes ?? {});

    if (fields.length === 0) {
      return '';
    }

    const rendered = fields
      .slice(0, SUMMARY_FIELDS)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ');

    const rest = fields.length - SUMMARY_FIELDS;
    const tail = rest > 0 ? ` +${rest}` : '';

    return rendered.length > SUMMARY_CHARS
      ? `${rendered.slice(0, SUMMARY_CHARS)}…${tail}`
      : `${rendered}${tail}`;
  }

  /** Clicking a scope filters to it: on a Rust service that is the module the
   * record came from, which is the question "what is this component doing". */
  protected filterByScope(scope: string): void {
    this.filters.patchValue({ scope });
    this.run();
  }

  /**
   * The message, without the terminal dressing.
   *
   * A service that writes colour to a TTY and ships the same string to OTLP
   * sends the escape codes along with it, and they render as mojibake in a
   * table — a Deno log arrived here as "ESC[0mESC[38;5;12mWatcher". Stripped
   * for display only: what was ingested is what is stored.
   */
  protected body(record: LogRecord): string {
    return record.Body.replace(ANSI, '');
  }

  /** OTel severity numbers: 1-4 trace, 5-8 debug, 9-12 info, 13-16 warn, 17+ error. */
  protected severityClass(severity: number): string {
    if (severity >= 17) return 'sev-error';
    if (severity >= 13) return 'sev-warn';
    if (severity >= 9) return 'sev-info';
    return 'sev-debug';
  }

  private currentFilters(): LogFilters {
    const { service, contains, scope, minSeverity, limit } = this.filters.getRawValue();
    const range = this.chosen$$.value;

    return {
      service: service ?? '',
      contains: contains ?? '',
      scope: scope ?? '',
      minSeverity: Number(minSeverity ?? 0),
      limit: limit ?? 200,
      from: new Date(Date.now() - range.windowMinutes * 60_000).toISOString(),
    };
  }
}
