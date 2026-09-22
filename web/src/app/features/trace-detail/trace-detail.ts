import { ChangeDetectionStrategy, Component, OnInit, inject, input } from '@angular/core';
import { AsyncPipe, DatePipe } from '@angular/common';
import { map, startWith } from 'rxjs';

import { TracesStore } from '../../core/traces.store';
import { Span } from '../../core/telemetry.model';
import { DurationPipe } from '../../shared/duration-pipe';

interface WaterfallRow {
  readonly span: Span;
  readonly depth: number;
  /** Percentages of the trace's total wall time. */
  readonly offset: number;
  readonly width: number;
}

@Component({
  selector: 'wt-trace-detail',
  imports: [AsyncPipe, DatePipe, DurationPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Trace <span class="mono">{{ traceId() }}</span></h1>

    <p class="status fx-flex fx-items-center fx-gap-2" aria-live="polite">
      {{ (spans$ | async)?.length ?? 0 }} spans{{ (loading$ | async) ? ' — streaming…' : '' }}
      @if (total$ | async; as ns) {
        · {{ ns | duration }} total
      }
    </p>

    <ol class="waterfall fx-m-0 fx-p-0">
      @for (row of waterfall$ | async; track row.span.SpanId) {
        <li [style.--depth]="row.depth">
          <div class="label fx-flex fx-gap-2" [title]="row.span.SpanName">
            <span class="service mono">{{ row.span.ServiceName }}</span>
            <span class="name">{{ row.span.SpanName }}</span>
          </div>
          <div class="track">
            <div
              class="bar"
              [class.errored]="row.span.StatusCode === 'Error'"
              [style.margin-inline-start.%]="row.offset"
              [style.width.%]="row.width"
            ></div>
          </div>
          <div class="meta fx-flex fx-gap-3 fx-flex-justify-end">
            <span class="num">{{ row.span.Duration | duration }}</span>
            <span [class]="'status-' + row.span.StatusCode">{{ row.span.StatusCode }}</span>
            <span class="dim">{{ row.span.Timestamp | date: 'HH:mm:ss.SSS' }}</span>
          </div>
        </li>
      } @empty {
        @if (!(loading$ | async)) {
          <li class="hint">No spans found for this trace.</li>
        }
      }
    </ol>
  `,
  styles: `
    .waterfall {
      list-style: none;
    }

    .waterfall li {
      display: grid;
      grid-template-columns: minmax(14rem, 22rem) 1fr minmax(12rem, auto);
      gap: 1rem;
      align-items: center;
      padding: 0.3rem 0;
      border-bottom: 1px solid var(--line);
    }

    .label {
      min-width: 0;
      padding-inline-start: calc(var(--depth, 0) * var(--fx-s));
    }

    .service {
      color: var(--text-dim);
      flex: none;
    }

    .name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .track {
      background: var(--surface);
      border-radius: 3px;
      height: 0.9rem;
    }

    .bar {
      height: 100%;
      min-width: 2px;
      border-radius: 3px;
      background: var(--accent);
    }

    .bar.errored {
      background: var(--error);
    }

    .meta {
      color: var(--text-dim);
    }

    .num {
      font-variant-numeric: tabular-nums;
      color: var(--text);
    }

    .status,
    .hint {
      color: var(--text-dim);
    }
  `,
})
export class TraceDetail implements OnInit {
  private readonly store = inject(TracesStore);

  readonly traceId = input.required<string>();

  protected readonly spans$ = this.store.trace$;
  protected readonly loading$ = this.store.getLoadingFor('loadTrace').pipe(startWith(false));

  /** Wall time from the first span's start to the last span's end. */
  protected readonly total$ = this.spans$.pipe(map(totalOf));

  /**
   * Parent-before-child ordering with each span positioned against the trace's
   * own timeline. Recomputed as rows arrive, so a long trace fills in rather
   * than appearing all at once.
   */
  protected readonly waterfall$ = this.spans$.pipe(map(toWaterfall));

  ngOnInit(): void {
    this.store.dispatch('loadTrace', this.traceId());
  }
}

function totalOf(spans: readonly Span[]): number {
  if (spans.length === 0) {
    return 0;
  }

  const start = Math.min(...spans.map(startOf));
  const end = Math.max(...spans.map((span) => startOf(span) + span.Duration));

  return end - start;
}

function toWaterfall(spans: readonly Span[]): WaterfallRow[] {
  if (spans.length === 0) {
    return [];
  }

  const origin = Math.min(...spans.map(startOf));
  const total = totalOf(spans) || 1;

  const children = new Map<string, Span[]>();
  for (const span of spans) {
    const siblings = children.get(span.ParentSpanId) ?? [];
    siblings.push(span);
    children.set(span.ParentSpanId, siblings);
  }

  const known = new Set(spans.map((span) => span.SpanId));
  // A span whose parent is absent is a root here — true for the real root and
  // for any span whose parent has not streamed in yet.
  const roots = spans.filter((span) => !span.ParentSpanId || !known.has(span.ParentSpanId));

  const out: WaterfallRow[] = [];
  const visit = (span: Span, depth: number): void => {
    out.push({
      span,
      depth,
      offset: ((startOf(span) - origin) / total) * 100,
      width: Math.max((span.Duration / total) * 100, 0.4),
    });

    for (const child of children.get(span.SpanId) ?? []) {
      visit(child, depth + 1);
    }
  };

  for (const root of [...roots].sort((a, b) => startOf(a) - startOf(b))) {
    visit(root, 0);
  }

  return out;
}

/** ClickHouse renders DateTime64(9) as `YYYY-MM-DD hh:mm:ss.nnnnnnnnn`; the
 * sub-millisecond digits matter for ordering spans, and `Date.parse` drops
 * them, so the fractional part is read separately. */
function startOf(span: Span): number {
  const [datePart, fraction = ''] = span.Timestamp.split('.');
  const millis = Date.parse(`${datePart.replace(' ', 'T')}Z`);
  const nanos = Number(fraction.padEnd(9, '0').slice(0, 9));

  return millis * 1e6 + nanos;
}
