import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';

import { RowStream } from '../../core/stream';
import { Telemetry } from '../../core/telemetry';
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
  imports: [DatePipe, DurationPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Trace <span class="mono">{{ traceId() }}</span></h1>

    <p class="status" aria-live="polite">
      {{ rows().length }} spans{{ streaming() ? ' — streaming…' : '' }}
      @if (total(); as ns) { · {{ ns | duration }} total }
    </p>

    @if (error(); as message) {
      <p role="alert" class="error">{{ message }}</p>
    }

    <ol class="waterfall">
      @for (row of waterfall(); track row.span.SpanId) {
        <li [style.--depth]="row.depth">
          <div class="label" [title]="row.span.SpanName">
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
          <div class="meta">
            <span class="num">{{ row.span.Duration | duration }}</span>
            <span [class]="'status-' + row.span.StatusCode">{{ row.span.StatusCode }}</span>
            <span class="dim">{{ row.span.Timestamp | date: 'HH:mm:ss.SSS' }}</span>
          </div>
        </li>
      } @empty {
        @if (!streaming()) {
          <li class="hint">No spans found for this trace.</li>
        }
      }
    </ol>
  `,
  styles: `
    .waterfall {
      list-style: none;
      margin: 0;
      padding: 0;
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
      display: flex;
      gap: 0.5rem;
      min-width: 0;
      padding-inline-start: calc(var(--depth, 0) * 1rem);
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
      display: flex;
      gap: 0.75rem;
      justify-content: end;
      color: var(--text-dim);
    }

    .num {
      font-variant-numeric: tabular-nums;
      color: var(--text);
    }

    .status { color: var(--text-dim); }
    .error { color: var(--error); }
    .hint { color: var(--text-dim); }
    .dim { color: var(--text-dim); }
  `,
})
export class TraceDetail {
  private readonly telemetry = inject(Telemetry);

  readonly traceId = input.required<string>();

  private readonly stream = signal<RowStream<Span> | null>(null);

  protected readonly rows = computed(() => this.stream()?.rows() ?? []);
  protected readonly streaming = computed(() => this.stream()?.state() === 'streaming');
  protected readonly error = computed(() => this.stream()?.error() ?? null);

  /** Wall time from the first span's start to the last span's end. */
  protected readonly total = computed(() => {
    const spans = this.rows();

    if (spans.length === 0) {
      return 0;
    }

    const start = Math.min(...spans.map((span) => startOf(span)));
    const end = Math.max(...spans.map((span) => startOf(span) + span.Duration));

    return end - start;
  });

  /**
   * Parent-before-child ordering with each span positioned against the trace's
   * own timeline. Recomputed as rows arrive, so a long trace fills in rather
   * than appearing all at once.
   */
  protected readonly waterfall = computed<WaterfallRow[]>(() => {
    const spans = this.rows();

    if (spans.length === 0) {
      return [];
    }

    const origin = Math.min(...spans.map(startOf));
    const total = this.total() || 1;

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

    for (const root of roots.sort((a, b) => startOf(a) - startOf(b))) {
      visit(root, 0);
    }

    return out;
  });

  constructor() {
    effect((onCleanup) => {
      const stream = this.telemetry.trace(this.traceId());
      this.stream.set(stream);
      onCleanup(() => stream.cancel());
    });
  }
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
