import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';

import { SeriesPoint } from '../core/telemetry.model';

/**
 * Categorical slots, in fixed order, stepped for this app's dark surface
 * (#151a21) and validated as a set: every slot clears the lightness band, the
 * chroma floor, 3:1 contrast, and the adjacent-pair separation floors for
 * colourblind and normal vision.
 *
 * Fixed order matters as much as the values: a service keeps its colour when a
 * filter changes how many series are on screen, so colour follows the entity
 * rather than its rank.
 */
const SERIES_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'];
/** Past this, hues would have to be reused; the tail folds into one grey band. */
const MAX_SERIES = SERIES_COLORS.length;
const OTHER_COLOR = '#6b7686';
const OTHER = 'Other';

interface Series {
  readonly name: string;
  readonly color: string;
  readonly values: number[];
  readonly total: number;
  readonly path: string;
  readonly labelY: number;
}

const VIEW = { width: 960, height: 260, left: 52, right: 118, top: 12, bottom: 28 };
/** Beyond this the direct label overruns its reserve; the legend still carries
 * the full name, so shortening here loses nothing. */
const LABEL_CHARS = 17;

@Component({
  selector: 'wt-volume-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <figure>
      <figcaption class="fx-flex fx-items-baseline fx-gap-2 fx-mb-1">
        <h2>{{ title() }}</h2>
        <span class="unit">{{ unit() }}</span>
      </figcaption>

      @if (series().length === 0) {
        <p class="empty">Nothing reported in this window.</p>
      } @else {
        <svg
          [attr.viewBox]="viewBox"
          role="img"
          [attr.aria-label]="title() + '. ' + describe()"
          (pointermove)="track($event)"
          (pointerleave)="hover.set(null)"
        >
          <!-- Recessive grid: present enough to read a value against, quiet
               enough that the data stays the loudest thing on screen. -->
          @for (line of gridLines(); track line.value) {
            <line class="grid" [attr.x1]="view.left" [attr.x2]="plotRight" [attr.y1]="line.y" [attr.y2]="line.y" />
            <text class="axis" [attr.x]="view.left - 8" [attr.y]="line.y + 4" text-anchor="end">
              {{ line.label }}
            </text>
          }

          @if (referenceLine(); as line) {
            <line class="reference" [attr.x1]="view.left" [attr.x2]="plotRight" [attr.y1]="line.y" [attr.y2]="line.y" />
            <text class="axis reference-label" [attr.x]="plotRight + 8" [attr.y]="line.y + 4">
              {{ line.label }}
            </text>
          }

          @for (tick of timeTicks(); track tick.index) {
            <text class="axis" [attr.x]="tick.x" [attr.y]="view.height - 8" text-anchor="middle">
              {{ tick.label }}
            </text>
          }

          @if (hover(); as point) {
            <line class="crosshair" [attr.x1]="point.x" [attr.x2]="point.x" [attr.y1]="view.top" [attr.y2]="plotBottom" />
          }

          @for (line of series(); track line.name) {
            <path class="series" [attr.d]="line.path" [attr.stroke]="line.color" />
          }

          <!-- Direct labels while there are few enough to place without
               collisions; the legend carries identity in every case. -->
          @if (series().length <= 4) {
            @for (line of series(); track line.name) {
              <text class="direct" [attr.x]="plotRight + 8" [attr.y]="line.labelY + 4" [attr.fill]="line.color">
                {{ shorten(line.name) }}
              </text>
            }
          }

          @if (hover(); as point) {
            @for (mark of point.marks; track mark.name) {
              <circle
                class="marker"
                [attr.cx]="point.x"
                [attr.cy]="mark.y"
                r="4"
                [attr.fill]="mark.color"
              />
            }
          }
        </svg>

        @if (hover(); as point) {
          <div class="tooltip" [style.left.%]="point.left" [style.transform]="point.flip ? 'translateX(-100%)' : ''">
            <strong>{{ point.label }}</strong>
            @for (mark of point.marks; track mark.name) {
              <span class="row">
                <span class="swatch" [style.background]="mark.color"></span>
                <span class="name">{{ mark.name }}</span>
                <span class="value">{{ mark.value }}</span>
              </span>
            }
          </div>
        }

        <ul class="legend fx-flex fx-flex-wrap fx-gap-3 fx-m-0 fx-p-0 fx-mt-2">
          @for (line of series(); track line.name) {
            <li class="fx-flex fx-items-center fx-gap-1"><span class="swatch" [style.background]="line.color"></span>{{ line.name }}</li>
          }
        </ul>
      }
    </figure>
  `,
  styles: `
    figure {
      margin: 0;
      position: relative;
    }

    h2 {
      margin: 0;
      font-size: 0.95rem;
      font-weight: 600;
    }

    .unit,
    .empty {
      color: var(--text-dim);
      font-size: 0.85rem;
    }

    svg {
      width: 100%;
      height: auto;
      overflow: visible;
      touch-action: none;
    }

    .grid {
      stroke: var(--line);
      stroke-width: 1;
    }

    .axis {
      fill: var(--text-dim);
      font-size: 11px;
    }

    .series {
      fill: none;
      stroke-width: 2;
      stroke-linejoin: round;
      stroke-linecap: round;
    }

    .direct {
      font-size: 11px;
    }

    .reference {
      stroke: var(--warn);
      stroke-width: 1;
      stroke-dasharray: 6 4;
    }

    .reference-label {
      fill: var(--warn);
    }

    .crosshair {
      stroke: var(--text-dim);
      stroke-width: 1;
      stroke-dasharray: 3 3;
    }

    .marker {
      stroke: var(--bg);
      stroke-width: 2;
    }

    .tooltip {
      position: absolute;
      top: 2.25rem;
      display: grid;
      gap: 0.15rem;
      padding: 0.5rem 0.65rem;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface-raised);
      font-size: 0.8rem;
      pointer-events: none;
      white-space: nowrap;
      z-index: 1;
    }

    .row {
      display: grid;
      grid-template-columns: 0.6rem 1fr auto;
      align-items: center;
      gap: 0.5rem;
    }

    .value {
      font-variant-numeric: tabular-nums;
    }

    .legend {
      list-style: none;
      color: var(--text-dim);
      font-size: var(--fx-typography--1);
    }

    .swatch {
      width: 0.6rem;
      height: 0.6rem;
      border-radius: 2px;
      display: inline-block;
    }
  `,
})
export class VolumeChart {
  /** Long-form series: one entry per bucket per series. Callers map their own
   * shape into this, so the chart knows nothing about telemetry. */
  readonly points = input.required<readonly SeriesPoint[]>();
  /** Drawn as a dashed reference line — a limit or a threshold the series
   * should be read against. */
  readonly reference = input<number | null>(null);
  readonly format = input<(value: number) => string>(compact);
  readonly title = input('Volume');
  readonly unit = input('per bucket');

  protected readonly view = VIEW;
  protected readonly viewBox = `0 0 ${VIEW.width} ${VIEW.height}`;
  protected readonly plotRight = VIEW.width - VIEW.right;
  protected readonly plotBottom = VIEW.height - VIEW.bottom;

  protected readonly hover = signal<{
    x: number;
    left: number;
    flip: boolean;
    label: string;
    marks: { name: string; color: string; value: number; y: number }[];
  } | null>(null);

  private readonly buckets = computed(() =>
    [...new Set(this.points().map((point) => point.bucket))].sort(),
  );

  protected readonly series = computed<Series[]>(() => {
    const buckets = this.buckets();

    if (buckets.length === 0) {
      return [];
    }

    const index = new Map(buckets.map((bucket, position) => [bucket, position]));
    const totals = new Map<string, number>();
    const rows = new Map<string, number[]>();

    for (const point of this.points()) {
      const row = rows.get(point.series) ?? new Array<number>(buckets.length).fill(0);
      row[index.get(point.bucket) ?? 0] += point.value;
      rows.set(point.series, row);
      totals.set(point.series, (totals.get(point.series) ?? 0) + point.value);
    }

    // Ranked by total, but no longer filtered by it: a series flat at zero is a
    // fact worth drawing. A counter that has stopped incrementing and a service
    // that has stopped reporting otherwise both render as an empty chart, which
    // reads as "no data" rather than as the answer.
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);

    const kept = ranked.slice(0, MAX_SERIES);
    const folded = ranked.slice(MAX_SERIES);

    const series = kept.map(([name, total], slot) => ({
      // A series with no attributes has no label of its own; the chart's title
      // is what it is.
      name: name || this.title(),
      total,
      color: SERIES_COLORS[slot],
      values: rows.get(name) ?? [],
    }));

    if (folded.length > 0) {
      const values = new Array<number>(buckets.length).fill(0);

      for (const [name] of folded) {
        (rows.get(name) ?? []).forEach((value, position) => (values[position] += value));
      }

      series.push({
        name: OTHER,
        total: folded.reduce((sum, [, total]) => sum + total, 0),
        color: OTHER_COLOR,
        values,
      });
    }

    const max = this.max();

    const placed = series.map((line) => ({
      ...line,
      path: line.values
        .map((value, position) => `${position === 0 ? 'M' : 'L'}${this.x(position)},${this.y(value, max)}`)
        .join(' '),
      labelY: this.y(line.values[line.values.length - 1] ?? 0, max),
    }));

    return dodge(placed);
  });

  private readonly max = computed(() => {
    const perBucket = new Map<string, number>();

    for (const point of this.points()) {
      const key = `${point.bucket}|${point.series}`;
      perBucket.set(key, (perBucket.get(key) ?? 0) + point.value);
    }

    // A reference line above every point still has to fit on the axis.
    return Math.max(1, this.reference() ?? 0, ...perBucket.values());
  });

  /** Where a limit or threshold sits on the axis, when one was given. */
  protected readonly referenceLine = computed(() => {
    const reference = this.reference();

    if (reference === null || reference <= 0) {
      return null;
    }

    return { y: this.y(reference, this.max()), label: this.format()(reference) };
  });

  protected readonly gridLines = computed(() => {
    const max = this.max();

    return [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
      const value = Math.round(max * fraction);

      return { value, y: this.y(value, max), label: this.format()(value) };
    });
  });

  protected readonly timeTicks = computed(() => {
    const buckets = this.buckets();
    const wanted = Math.min(6, buckets.length);
    const step = Math.max(1, Math.floor(buckets.length / wanted));

    return buckets
      .map((bucket, index) => ({ bucket, index }))
      .filter(({ index }) => index % step === 0)
      .map(({ bucket, index }) => ({
        index,
        x: this.x(index),
        label: shortTime(bucket, this.spansDays()),
      }));
  });

  /** Over more than a day, a bare `14:00` appears several times and names
   * nothing; the tick has to carry the date too. */
  private readonly spansDays = computed(() => {
    const buckets = this.buckets();

    if (buckets.length < 2) {
      return false;
    }

    return buckets[0].slice(0, 10) !== buckets[buckets.length - 1].slice(0, 10);
  });

  protected shorten(name: string): string {
    return name.length > LABEL_CHARS ? `${name.slice(0, LABEL_CHARS - 1)}…` : name;
  }

  protected describe(): string {
    return this.series()
      .map((line) => `${line.name}: ${line.total}`)
      .join(', ');
  }

  /** Snaps to the nearest bucket rather than interpolating, because there is no
   * value between two buckets — only the illusion of one. */
  protected track(event: PointerEvent): void {
    const svg = event.currentTarget as SVGSVGElement;
    const bounds = svg.getBoundingClientRect();
    const buckets = this.buckets();

    if (buckets.length === 0) {
      return;
    }

    const ratio = (event.clientX - bounds.left) / bounds.width;
    const position = Math.round(
      ((ratio * VIEW.width - VIEW.left) / (this.plotRight - VIEW.left)) * (buckets.length - 1),
    );
    const index = Math.min(Math.max(position, 0), buckets.length - 1);
    const max = this.max();

    this.hover.set({
      x: this.x(index),
      left: (this.x(index) / VIEW.width) * 100,
      // Near the right edge the tooltip would leave the figure; flip it.
      flip: index > buckets.length * 0.7,
      label: shortTime(buckets[index], true),
      marks: this.series().map((line) => ({
        name: line.name,
        color: line.color,
        value: line.values[index] ?? 0,
        y: this.y(line.values[index] ?? 0, max),
      })),
    });
  }

  private x(index: number): number {
    const count = Math.max(1, this.buckets().length - 1);

    return VIEW.left + (index / count) * (this.plotRight - VIEW.left);
  }

  private y(value: number, max: number): number {
    return this.plotBottom - (value / max) * (this.plotBottom - VIEW.top);
  }
}

/**
 * Pushes direct labels apart so they stay readable.
 *
 * Series that end at similar values — which is most of them, since a quiet
 * service ends at zero like every other quiet service — would otherwise stack
 * their labels on the same baseline and overprint into a smear.
 */
function dodge(series: Series[]): Series[] {
  const MIN_GAP = 13;
  const ordered = [...series].sort((a, b) => a.labelY - b.labelY);
  let previous = -Infinity;

  for (const line of ordered) {
    const y = Math.max(line.labelY, previous + MIN_GAP);
    (line as { labelY: number }).labelY = y;
    previous = y;
  }

  return series;
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

/** ClickHouse renders `YYYY-MM-DD hh:mm:ss`; the axis wants the time, the
 * tooltip wants enough to know which day. */
function shortTime(bucket: string, withDate = false): string {
  const [date, time] = bucket.split(' ');
  const hhmm = (time ?? '').slice(0, 5);

  return withDate ? `${(date ?? '').slice(5)} ${hhmm}` : hhmm;
}
