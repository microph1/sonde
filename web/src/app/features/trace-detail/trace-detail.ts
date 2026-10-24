import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { AsyncPipe, DatePipe, DecimalPipe } from '@angular/common';
import { BehaviorSubject, combineLatest, defer, map, startWith } from 'rxjs';

import { TracesStore } from '../../core/traces.store';
import { Attributes, Span } from '../../core/telemetry.model';
import { CopyButton } from '../../shared/copy-button';
import { DurationPipe } from '../../shared/duration-pipe';

interface WaterfallRow {
  readonly span: Span;
  readonly depth: number;
  /** Percentages of the trace's total wall time. */
  readonly offset: number;
  readonly width: number;
  /** What went wrong, when something did. See `failureOf`. */
  readonly failure?: SpanFailure;
  /** What the span did, in one line, when its attributes say enough to tell.
   * See `summarise`. */
  readonly summary?: string;
  readonly attributes: Field[];
  /** Everything the instrumentation marked on the way through, minus the
   * exception that is already shown as the failure. */
  readonly events: SpanEvent[];
}

interface Field {
  readonly key: string;
  readonly value: string;
}

interface SpanEvent {
  readonly name: string;
  /** Milliseconds after the span started: the only reading that makes a mark
   * comparable to the bar it sits under. */
  readonly at: number;
  readonly fields: Field[];
}

/**
 * The readable part of a failed span: `exception.type`, a message, and the
 * stack when it says more than the message does.
 */
interface SpanFailure {
  readonly type?: string;
  readonly message: string;
  readonly stack?: string;
}

@Component({
  selector: 'wt-trace-detail',
  imports: [AsyncPipe, DatePipe, DecimalPipe, DurationPipe, CopyButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `

    <!-- The trace id left the row when the row became a panel header, and it
         is the thing you paste into a message to someone. -->
    <p class="trace-id fx-flex fx-items-center fx-gap-1">
      <span class="dim">Trace</span>
      <code>{{ traceId() }}</code>
      <wt-copy [value]="traceId()" label="Copy the trace id" />
    </p>

    <p class="status fx-flex fx-items-center fx-gap-2" aria-live="polite">
      {{ (spans$ | async)?.length ?? 0 }} spans{{ (loading$ | async) ? ' — streaming…' : '' }}
      @if (total$ | async; as ns) {
        · {{ ns | duration }} total
      }
    </p>

    <ol class="waterfall fx-m-0 fx-p-0">
      @for (row of waterfall$ | async; track row.span.SpanId) {
        <li [style.--depth]="row.depth">
          <!-- The label is the handle: a span carries everything the
               instrumentation knew about the operation, and until now the row
               showed its name and its duration and dropped the rest. -->
          <button
            type="button"
            class="label fx-flex fx-items-center fx-gap-2"
            [title]="row.span.SpanName"
            [attr.aria-expanded]="(open$ | async)?.has(row.span.SpanId) ?? false"
            (click)="toggle(row.span.SpanId)"
          >
            <span class="chevron" aria-hidden="true">{{ (open$ | async)?.has(row.span.SpanId) ? '▾' : '▸' }}</span>
            <span class="service mono">{{ row.span.ServiceName }}</span>
            <span class="name">{{ row.span.SpanName }}</span>
          </button>
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

          <!-- A span marked Error used to say only "Error", and the reason it
               carried — the status message and the exception event — was
               readable solely through the API. A service that ships no logs
               (the streamer's Electron main process is one) then had a red bar
               and nothing under it. -->
          @if (row.failure; as failure) {
            <div class="failure">
              <p class="fx-m-0">
                @if (failure.type) {
                  <span class="exc-type mono">{{ failure.type }}</span>
                }
                <span class="exc-message">{{ failure.message }}</span>
              </p>
              @if (failure.stack) {
                <pre class="stack mono">{{ failure.stack }}</pre>
              }
            </div>
          }

          @if ((open$ | async)?.has(row.span.SpanId)) {
            <div class="detail">
              @if (row.summary) {
                <!-- The conventions, read into one line. Underneath is
                     everything, including the keys no convention covers. -->
                <p class="summary mono fx-m-0">{{ row.summary }}</p>
              }

              @if (row.attributes.length) {
                <dl class="fields">
                  @for (field of row.attributes; track field.key) {
                    <div>
                      <dt class="mono dim">{{ field.key }}</dt>
                      <dd class="mono">{{ field.value }}</dd>
                    </div>
                  }
                </dl>
              } @else {
                <p class="dim fx-m-0">This span carries no attributes.</p>
              }

              @if (row.events.length) {
                <ol class="events fx-m-0 fx-p-0">
                  @for (event of row.events; track $index) {
                    <li>
                      <span class="at dim">+{{ event.at | number: '1.0-1' }} ms</span>
                      <span class="event-name mono">{{ event.name }}</span>
                      <span class="event-fields dim mono">
                        @for (field of event.fields; track field.key) {
                          {{ field.key }}={{ field.value }}
                        }
                      </span>
                    </li>
                  }
                </ol>
              }
            </div>
          }
        </li>
      } @empty {
        @if (!(loading$ | async)) {
          <li class="hint">No spans found for this trace.</li>
        }
      }
    </ol>
    @if (logs$ | async; as logs) {
      @if (logs.length) {
        <h2 class="logs-head">
          {{ logs.length }} log {{ logs.length === 1 ? 'record' : 'records' }}
        </h2>

        <ol class="logs fx-m-0 fx-p-0">
          @for (line of logs; track $index) {
            <li class="line">
              <time class="dim">{{ line.record.Timestamp | date: 'HH:mm:ss.SSS' }}</time>
              <span class="chip" [class]="'chip ' + severityClass(line.record.SeverityNumber)">
                {{ line.record.SeverityText || '—' }}
              </span>
              <!-- Which step of the trace said it. A line attributed to nothing
                   is a line you have to go and place yourself. -->
              <span class="from mono dim" [title]="line.record.ServiceName">{{ line.span }}</span>
              <span class="body">
                {{ line.record.Body }}
                @if (line.fields) {
                  <span class="fields dim">{{ line.fields }}</span>
                }
              </span>
            </li>
          }
        </ol>
      }
    }
  `,
  styles: `
    .trace-id {
      margin: 0;
      font-size: var(--fx-typography--1);
    }

    :host {
      display: block;
      padding-block: var(--fx-2xs) var(--fx-s);
    }



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
      /* A button, because it opens something; styled as the row it has always
         been. */
      appearance: none;
      border: 0;
      background: none;
      padding-block: 0;
      padding-inline-end: 0;
      color: inherit;
      font: inherit;
      text-align: start;
      cursor: pointer;
    }

    .label:hover .name,
    .label:focus-visible .name {
      color: var(--accent);
    }

    .chevron {
      flex: none;
      width: 0.8em;
      color: var(--text-dim);
    }

    /* Raised, bordered and shadowed rather than flat on the card. It sits
       between two rows that look exactly like the one it belongs to, so
       without an edge of its own there is nothing to say where the span's
       detail stops and the next span starts. */
    .detail {
      grid-column: 1 / -1;
      margin-block: 0.4rem 0.6rem;
      margin-inline-start: calc(var(--depth, 0) * var(--fx-s) + 0.8rem);
      padding: 0.6rem 0.75rem;
      border: 1px solid var(--line);
      border-radius: var(--mat-sys-corner-small);
      background: var(--surface-raised);
      box-shadow: 0 1px 4px rgb(0 0 0 / 0.35);
      font-size: var(--fx-typography--1);
    }

    .summary {
      color: var(--text);
      margin-block-end: 0.4rem;
    }

    /* Keys in a column of their own: the point of a table of attributes is
       scanning down the keys, which wrapping pairs make impossible. */
    .fields {
      display: grid;
      grid-template-columns: minmax(8rem, max-content) minmax(0, 1fr);
      gap: 0.1rem 1rem;
      margin: 0;
    }

    .fields > div {
      display: contents;
    }

    .fields dt,
    .fields dd {
      margin: 0;
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .events {
      list-style: none;
      margin-block-start: 0.5rem;
      border-block-start: 1px solid var(--line);
      padding-block-start: 0.4rem;
    }

    .events li {
      display: grid;
      grid-template-columns: 5rem minmax(6rem, max-content) minmax(0, 1fr);
      gap: 0.6rem;
    }

    .events .at {
      text-align: end;
      font-variant-numeric: tabular-nums;
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

    /* Spans the whole row: the grid's three columns are the bar's, and the
       reason belongs under all of them rather than in the duration's. */
    /* The same raised block as the detail below it, kept apart by its edge
       rather than by its colour. */
    .failure {
      grid-column: 1 / -1;
      margin-block: 0.4rem 0;
      margin-inline-start: calc(var(--depth, 0) * var(--fx-s) + 0.8rem);
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--line);
      border-inline-start: 2px solid var(--error);
      border-radius: var(--mat-sys-corner-small);
      background: var(--surface-raised);
      box-shadow: 0 1px 4px rgb(0 0 0 / 0.35);
      font-size: var(--fx-typography--1);
    }

    .exc-type {
      color: var(--error);
      margin-inline-end: 0.4rem;
    }

    .exc-message {
      color: var(--text);
    }

    .stack {
      margin: 0.4rem 0 0;
      max-height: 14rem;
      overflow: auto;
      white-space: pre-wrap;
      color: var(--text-dim);
    }
  `,
})
export class TraceDetail {
  private readonly store = inject(TracesStore);

  readonly traceId = input.required<string>();

  /**
   * This trace's spans. The store keys them by id, so several open rows can
   * each draw their own without taking turns.
   *
   * `defer` because a required signal input cannot be read while the field it
   * would initialise is still being constructed; subscribing is late enough.
   */
  protected readonly spans$ = defer(() => this.store.spansFor(this.traceId()));
  protected readonly loading$ = this.store.getLoadingFor('loadTrace').pipe(startWith(false));

  /** Which rows are open, by span id. A set rather than one id: reading a
   * trace is comparing its steps, which means having two of them open. */
  private readonly open$$ = new BehaviorSubject<ReadonlySet<string>>(new Set());

  protected readonly open$ = this.open$$.asObservable();

  /** Wall time from the first span's start to the last span's end. */
  protected readonly total$ = this.spans$.pipe(map(totalOf));

  /**
   * Parent-before-child ordering with each span positioned against the trace's
   * own timeline. Recomputed as rows arrive, so a long trace fills in rather
   * than appearing all at once.
   */
  protected readonly waterfall$ = this.spans$.pipe(map(toWaterfall));

  /**
   * The trace's log lines, each attached to the span that emitted it.
   *
   * Every record already carried the span id; it was only ever a question of
   * showing the two together. A line whose span is not in this trace's spans
   * keeps the trace but loses the step name, which is honest — the span may
   * simply not have been recorded.
   */
  protected readonly logs$ = combineLatest([
    defer(() => this.store.logsFor(this.traceId())),
    this.spans$,
  ]).pipe(
    map(([records, spans]) => {
      const names = new Map(spans.map((span) => [span.SpanId, span.SpanName]));

      return [...records]
        .sort((a, b) => a.Timestamp.localeCompare(b.Timestamp))
        .map((record) => ({
          record,
          span: names.get(record.SpanId) ?? '—',
          fields: Object.entries(record.LogAttributes ?? {})
            .slice(0, 3)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(' '),
        }));
    }),
  );

  protected toggle(spanId: string): void {
    const open = new Set(this.open$$.value);

    open.has(spanId) ? open.delete(spanId) : open.add(spanId);
    this.open$$.next(open);
  }

  /** OTel severity numbers: 1-4 trace, 5-8 debug, 9-12 info, 13-16 warn, 17+ error. */
  protected severityClass(severity: number): string {
    if (severity >= 17) return 'sev-error';
    if (severity >= 13) return 'sev-warn';
    if (severity >= 9) return 'sev-info';
    return 'sev-debug';
  }

  // No lifecycle fetch: whoever opens this decides when to load, because a
  // panel that is reopened rather than recreated never gets another one.
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
      failure: failureOf(span),
      summary: summarise(span.SpanAttributes ?? {}),
      attributes: fieldsOf(span.SpanAttributes ?? {}),
      events: eventsOf(span),
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

/**
 * Why a span failed, from the two places the reason can be.
 *
 * `recordException` writes an `exception` event and `setStatus` writes the
 * status message; most code here does both, but either can stand alone — a
 * span can be set to Error without an exception, and an exception can be
 * recorded on a span that still reports Unset. Both are shown.
 *
 * The first exception event wins. Later ones are usually the same failure
 * re-thrown through a wrapper, and a span's first exception is the one that
 * says where it started.
 */
function failureOf(span: Span): SpanFailure | undefined {
  const index = (span.EventsName ?? []).indexOf('exception');
  const event = index >= 0 ? (span.EventsAttributes?.[index] ?? {}) : {};

  const type = str(event['exception.type']);
  const message = str(event['exception.message']) || span.StatusMessage;
  const stack = str(event['exception.stacktrace']);

  if (span.StatusCode !== 'Error' && index < 0) {
    return undefined;
  }

  // An Error with nothing attached is still worth marking — otherwise the row
  // claims a failure and the panel under it stays empty, which is the thing
  // this block exists to stop.
  return {
    type,
    message: message || 'No message was recorded.',
    // Node stringifies a bare Error to `Type: message`, so the stack is very
    // often exactly what is already on the line above it.
    stack: stack && stack !== message && stack !== `${type}: ${message}` ? stack : undefined,
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/** The first of these keys that the span actually carries. */
function pick(attributes: Attributes, ...keys: string[]): string {
  for (const key of keys) {
    const value = str(attributes[key]);

    if (value) {
      return value;
    }
  }

  return '';
}

/**
 * What the span did, in one line.
 *
 * Only from the conventions, and only when they say enough: a line assembled
 * out of half-recognised keys is worse than the table underneath, which at
 * least does not pretend to have understood.
 *
 * Both spellings of every HTTP key, because this console reads from whatever
 * is instrumented rather than from one generation of the spec — and both are
 * in the data: 891 spans here use `http.request.method` and 249 the older
 * `http.method`. Reading one of them summarises a quarter of the HTTP spans as
 * a blank line.
 */
function summarise(attributes: Attributes): string | undefined {
  const method = pick(attributes, 'http.request.method', 'http.method');

  if (method) {
    const target =
      pick(attributes, 'url.full', 'http.url') ||
      [
        pick(attributes, 'url.scheme', 'http.scheme'),
        pick(attributes, 'server.address', 'http.host', 'net.peer.name'),
      ]
        .filter(Boolean)
        .join('://') + pick(attributes, 'url.path', 'http.target', 'http.route');

    const status = pick(attributes, 'http.response.status_code', 'http.status_code');
    const size = pick(attributes, 'http.response.body.size', 'http.response_content_length');

    return [
      `${method} ${target}`.trim(),
      status && `→ ${status}`,
      size && `· ${bytes(Number(size))}`,
    ]
      .filter(Boolean)
      .join(' ');
  }

  const db = pick(attributes, 'db.system.name', 'db.system');

  if (db) {
    const operation = pick(attributes, 'db.operation.name', 'db.operation');
    const collection = pick(attributes, 'db.collection.name', 'db.sql.table', 'db.name');
    const statement = pick(attributes, 'db.query.text', 'db.statement');

    return [db, operation, collection, statement && `· ${statement}`].filter(Boolean).join(' ');
  }

  const rpc = pick(attributes, 'rpc.system');

  if (rpc) {
    const service = pick(attributes, 'rpc.service');
    const method = pick(attributes, 'rpc.method');

    return [rpc, [service, method].filter(Boolean).join('/')].filter(Boolean).join(' ');
  }

  return undefined;
}

/** Everything on the span, sorted, with nothing interpreted. The custom keys
 * live here — `musicbox.album.id` is not in any spec and is often the one that
 * answers the question. */
function fieldsOf(attributes: Attributes): Field[] {
  return Object.entries(attributes)
    .map(([key, value]) => ({ key, value: str(value) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * The span's events, as offsets from its start.
 *
 * The exception is dropped: it is already rendered above as the failure, and
 * repeating it here would push the marks that are not an exception — the
 * browser's `fetchStart`, `connectEnd`, `responseEnd` — off the bottom.
 */
function eventsOf(span: Span): SpanEvent[] {
  const names = span.EventsName ?? [];
  const times = span.EventsTimestamp ?? [];
  const attributes = span.EventsAttributes ?? [];
  const start = startOf(span);

  return names
    .map((name, index) => ({ name, index }))
    .filter(({ name }, index) => !(name === 'exception' && index === names.indexOf('exception')))
    .map(({ name, index }) => ({
      name,
      at: times[index] ? (nanosOf(times[index]) - start) / 1e6 : 0,
      fields: fieldsOf(attributes[index] ?? {}),
    }));
}

/** A content length is unreadable in bytes past about a kilobyte, and reading
 * it is the whole reason it is on the line. */
function bytes(value: number): string {
  if (!Number.isFinite(value)) {
    return '';
  }

  if (value < 1024) {
    return `${value} B`;
  }

  return value < 1024 * 1024
    ? `${(value / 1024).toFixed(1)} kB`
    : `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/** ClickHouse renders DateTime64(9) as `YYYY-MM-DD hh:mm:ss.nnnnnnnnn`; the
 * sub-millisecond digits matter for ordering spans, and `Date.parse` drops
 * them, so the fractional part is read separately. */
function startOf(span: Span): number {
  return nanosOf(span.Timestamp);
}

function nanosOf(timestamp: string): number {
  const [datePart, fraction = ''] = timestamp.split('.');
  const millis = Date.parse(`${datePart.replace(' ', 'T')}Z`);
  const nanos = Number(fraction.padEnd(9, '0').slice(0, 9));

  return millis * 1e6 + nanos;
}
