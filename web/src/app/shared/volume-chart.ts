import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';

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
  readonly values: (number | null)[];
  readonly total: number;
  readonly path: string;
  readonly labelY: number;
  /** The same shape closed to the baseline, when the chart draws a fill. */
  readonly area: string;
}

/**
 * The coordinate system, and with it the shape of the chart.
 *
 * The svg is sized by its width and keeps the aspect this box describes, so
 * these two numbers are the only thing deciding how tall a chart ends up. At
 * 960 by 260 a full-width chart was three hundred and eighty pixels of mostly
 * empty rectangle — fine beside another chart at half the width, far too tall
 * once one of them had the page to itself.
 */
const VIEW = { width: 1440, height: 300, left: 60, right: 130, top: 14, bottom: 30 };
/** How far above the data a reference line may sit and still be drawn. Past
 * this it wins the axis and flattens the series it was meant to give context
 * to; see `referenceFits`. */
const REFERENCE_HEADROOM = 1.5;
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

        <!-- A limit too far above the data to draw is still worth knowing. -->
        @if (headroom(); as reading) {
          <span class="unit headroom">· {{ reading }}</span>
        }
      </figcaption>

      @if (series().length === 0) {
        <p class="empty">{{ empty() }}</p>
      } @else {
        <svg
          [attr.viewBox]="viewBox()"
          role="img"
          [attr.aria-label]="title() + '. ' + describe()"
          (pointermove)="track($event)"
          (pointerleave)="hover.set(null)"
        >
          <!-- Recessive grid: present enough to read a value against, quiet
               enough that the data stays the loudest thing on screen. -->
          @for (line of gridLines(); track line.value) {
            <line class="grid" [attr.x1]="view.left" [attr.x2]="plotRight()" [attr.y1]="line.y" [attr.y2]="line.y" />
            <text class="axis" [attr.x]="view.left - 8" [attr.y]="line.y + 4" text-anchor="end">
              {{ line.label }}
            </text>
          }

          @if (referenceLine(); as line) {
            <line class="reference" [attr.x1]="view.left" [attr.x2]="plotRight()" [attr.y1]="line.y" [attr.y2]="line.y" />
            <text class="axis reference-label" [attr.x]="plotRight() + 8" [attr.y]="line.y + 4">
              {{ line.label }}
            </text>
          }

          @for (tick of timeTicks(); track tick.index) {
            <text class="axis" [attr.x]="tick.x" [attr.y]="height() - 8" text-anchor="middle">
              {{ tick.label }}
            </text>
          }

          @if (hover(); as point) {
            <line class="crosshair" [attr.x1]="point.x" [attr.x2]="point.x" [attr.y1]="view.top" [attr.y2]="plotBottom()" />
          }

          @for (line of series(); track line.name) {
            @if (line.area) {
              <!-- Faded rather than flat: a slab of colour under a level
                   series reads as a filled bar, and the eye takes the top of
                   it for the measurement twice. -->
              <defs>
                <linearGradient [attr.id]="fillId" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" [attr.stop-color]="line.color" stop-opacity="0.3" />
                  <stop offset="1" [attr.stop-color]="line.color" stop-opacity="0.02" />
                </linearGradient>
              </defs>
              <path class="area" [attr.d]="line.area" [attr.fill]="'url(#' + fillId + ')'" />
            }
            <path class="series" [attr.d]="line.path" [attr.stroke]="line.color" />
          }

          <!-- Direct labels only where they can be placed without fighting:
               two lines that converge already stack their labels on one spot,
               and four of them pile into a block that also lands on the time
               axis. The legend carries identity in every case, and a compact
               strip has no room for them at all. -->
          @if (labelled()) {
            @for (line of series(); track line.name) {
              <text class="direct" [attr.x]="plotRight() + 8" [attr.y]="line.labelY + 4" [attr.fill]="line.color">
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
    /* The host is what gets measured, and an inline element measures as its
       content rather than as its column. */
    :host {
      display: block;
    }

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
      /* One user unit is one pixel, so the box the viewBox describes is the
         box on screen. */
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

    /* Enough to read the shape against the grid, little enough that two
       overlapping lines are still two lines. */
    .area {
      stroke: none;
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
  private readonly host = inject(ElementRef<HTMLElement>);

  constructor() {
    // Measured rather than assumed, and re-measured when the column changes:
    // the same component draws a full-width chart and one of a pair, and the
    // only honest way to keep both the right height is to know how wide each
    // one ended up.
    const observer = new ResizeObserver(([entry]) =>
      this.measured.set(Math.max(360, Math.round(entry.contentRect.width))),
    );

    observer.observe(this.host.nativeElement);
    inject(DestroyRef).onDestroy(() => observer.disconnect());
  }

  /** Long-form series: one entry per bucket per series. Callers map their own
   * shape into this, so the chart knows nothing about telemetry. */
  readonly points = input.required<readonly SeriesPoint[]>();
  /** Drawn as a dashed reference line — a limit or a threshold the series
   * should be read against. */
  readonly reference = input<number | null>(null);
  readonly format = input<(value: number) => string>(compact);
  readonly title = input('Volume');
  /** What an absence means here. The caller is the one that knows whether
   * nothing was reported or whether there is not yet enough of it to draw a
   * rate from — one bucket of a brand new counter is a reading with nothing
   * to subtract. */
  readonly empty = input('Nothing reported in this window.');
  readonly unit = input('per bucket');
  /** Colour by series name, for series whose name carries a meaning the chart
   * cannot infer — severity being the one that matters. */
  readonly colors = input<Record<string, string>>({});

  /**
   * Shorter, for a chart that is a strip above something else rather than the
   * thing you came to look at. The viewBox is what changes, so the whole plot
   * follows: a chart squeezed by CSS alone would letterbox or stretch its
   * labels.
   */
  readonly compact = input(false);

  /** A gradient lives in the document, so two charts on one page need two ids
   * or the second quietly paints with the first's colour. */
  protected readonly fillId = `fill-${Math.random().toString(36).slice(2, 9)}`;

  /**
   * The box, measured rather than assumed.
   *
   * One user unit is one pixel, so the chart is the same height whatever
   * column it lands in and its text and strokes are the same weight in all of
   * them. A fixed viewBox cannot do that: the svg keeps its aspect, so the one
   * ratio that gives a full-width chart a sensible height squashes the pair of
   * them that share a row on the overview.
   */
  private readonly measured = signal(VIEW.width);

  protected readonly height = computed(() => (this.compact() ? 130 : VIEW.height));
  protected readonly view = VIEW;
  protected readonly viewBox = computed(() => `0 0 ${this.measured()} ${this.height()}`);
  /** Whether the lines are named beside their last point. Read from `lines`
   * rather than `series`, because `series` needs the geometry this decides. */
  protected readonly labelled = computed(() => this.lines().length <= 2 && !this.compact());

  /** The reserve on the right is for those labels; without them it is dead
   * space, and on a half-width chart it was a tenth of the plot. */
  protected readonly plotRight = computed(
    () => this.measured() - (this.labelled() ? VIEW.right : 24),
  );
  protected readonly plotBottom = computed(() => this.height() - VIEW.bottom);

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

  /**
   * The lines, before they are given a shape.
   *
   * Split out from `series` so the scale can be taken from what is actually
   * drawn. It used to be taken from the raw points, which miss the one line
   * that is not a point: everything past the top few collapses into Other, and
   * Other is their sum. With enough services that sum is several times the
   * largest single series, so its line left the top of the plot — and the SVG
   * paints outside its box, so it ran up the page and across the tiles.
   */
  private readonly lines = computed<Omit<Series, 'path' | 'labelY' | 'area'>[]>(() => {
    const buckets = this.buckets();

    if (buckets.length === 0) {
      return [];
    }

    const index = new Map(buckets.map((bucket, position) => [bucket, position]));
    const totals = new Map<string, number>();
    // Null until something lands in it, so a bucket the instrument never
    // reported stays a hole rather than becoming a zero: the line breaks there
    // instead of diving to the axis and back.
    const rows = new Map<string, (number | null)[]>();

    for (const point of this.points()) {
      const row = rows.get(point.series) ?? new Array<number | null>(buckets.length).fill(null);
      const at = index.get(point.bucket) ?? 0;

      if (point.value !== null) {
        row[at] = (row[at] ?? 0) + point.value;
        totals.set(point.series, (totals.get(point.series) ?? 0) + point.value);
      }

      rows.set(point.series, row);
      totals.set(point.series, totals.get(point.series) ?? 0);
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
      // A caller that knows what its series mean can say so: `error` has to be
      // red wherever it appears, and a palette handed out by rank would colour
      // it by how much of it there happened to be.
      color: this.colors()[name] ?? SERIES_COLORS[slot],
      values: rows.get(name) ?? [],
    }));

    if (folded.length > 0) {
      // Null until one of the folded series reports: an "Other" of nothing is
      // a hole, not a floor.
      const values = new Array<number | null>(buckets.length).fill(null);

      for (const [name] of folded) {
        (rows.get(name) ?? []).forEach((value, position) => {
          if (value !== null) {
            values[position] = (values[position] ?? 0) + value;
          }
        });
      }

      series.push({
        name: OTHER,
        total: folded.reduce((sum, [, total]) => sum + total, 0),
        color: OTHER_COLOR,
        values,
      });
    }

    return series;
  });

  protected readonly series = computed<Series[]>(() => {
    const max = this.max();

    const lines = this.lines();
    // An area under a single line reads as a quantity rather than as a wire,
    // and one line is the only case where a fill cannot be mistaken for the
    // overlap of two.
    const filled = lines.length === 1;

    const floor = this.plotBottom();

    const placed = lines.map((line) => {
      // One run per stretch of consecutive readings, so a window the
      // instrument was silent through is a gap in the line rather than a
      // straight stride across it.
      const runs: (readonly [number, number])[][] = [];
      let run: (readonly [number, number])[] = [];

      line.values.forEach((value, position) => {
        if (value === null) {
          if (run.length > 0) {
            runs.push(run);
            run = [];
          }

          return;
        }

        run.push([this.x(position), this.y(value, max)] as const);
      });

      if (run.length > 0) {
        runs.push(run);
      }

      return {
        ...line,
        path: runs.map((points) => curve(points)).join(' '),
        area: filled
          ? runs
              .filter((points) => points.length > 1)
              .map(
                (points) =>
                  `${curve(points)} L${points[points.length - 1][0]},${floor} L${points[0][0]},${floor} Z`,
              )
              .join(' ')
          : '',
        labelY: this.y(lastReading(line.values), max),
      };
    });

    return dodge(placed);
  });

  private readonly dataMax = computed(() =>
    Math.max(
      1,
      ...this.lines().flatMap((line) =>
        line.values.filter((value): value is number => value !== null),
      ),
    ),
  );

  private readonly max = computed(() =>
    this.referenceFits() ? Math.max(this.dataMax(), this.reference() ?? 0) : this.dataMax(),
  );

  /**
   * Whether the limit can share an axis with the data.
   *
   * A healthy service is the case this gets wrong: 16 MB against a 256 MB cap
   * put the top of the axis sixteen times above every point, and the series
   * anyone was reading became a flat line on the floor — the healthier the
   * service, the less readable its own chart. So the limit only takes part in
   * the scale when the data is within reach of it, which is exactly when "am I
   * near the cap" is the question being asked. Otherwise the axis belongs to
   * the data and the cap is reported as a figure instead.
   */
  private readonly referenceFits = computed(() => {
    const reference = this.reference();

    return reference !== null && reference > 0 && reference <= this.dataMax() * REFERENCE_HEADROOM;
  });

  /** Where a limit or threshold sits on the axis, when one was given and it
   * fits. */
  protected readonly referenceLine = computed(() => {
    const reference = this.reference();

    if (!this.referenceFits() || reference === null) {
      return null;
    }

    return { y: this.y(reference, this.max()), label: this.format()(reference) };
  });

  /** The same fact the line would have carried, for when it is off the scale:
   * what is being used, out of what, as a share. */
  protected readonly headroom = computed(() => {
    const reference = this.reference();

    if (reference === null || reference <= 0 || this.referenceFits()) {
      return '';
    }

    const peak = this.dataMax();
    const share = Math.round((peak / reference) * 100);

    return `${this.format()(peak)} of ${this.format()(reference)} (${share < 1 ? '<1' : share}%)`;
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
      ((ratio * this.measured() - VIEW.left) / (this.plotRight() - VIEW.left)) * (buckets.length - 1),
    );
    const index = Math.min(Math.max(position, 0), buckets.length - 1);
    const max = this.max();

    this.hover.set({
      x: this.x(index),
      left: (this.x(index) / this.measured()) * 100,
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

    return VIEW.left + (index / count) * (this.plotRight() - VIEW.left);
  }

  private y(value: number, max: number): number {
    return this.plotBottom() - (value / max) * (this.plotBottom() - VIEW.top);
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

/**
 * ClickHouse renders `YYYY-MM-DD hh:mm:ss` in UTC; the axis wants the time, the
 * tooltip wants enough to know which day — both in the reader's own zone.
 *
 * The string used to be sliced and printed as it arrived, so every chart was
 * labelled in UTC while every timestamp beside it was local. Nobody notices on
 * a relative window; ask for 09:00 to 12:00 and an axis reading 07:00 to 10:00
 * is the whole page calling itself a liar.
 */
function shortTime(bucket: string, withDate = false): string {
  const at = new Date(`${bucket.replace(' ', 'T')}Z`);

  if (Number.isNaN(at.getTime())) {
    return bucket;
  }

  const hhmm = at.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  return withDate
    ? `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${hhmm}`
    : hhmm;
}

/**
 * A path through the points, eased rather than folded.
 *
 * Monotone cubic, not a plain spline: an ordinary smoothing curve overshoots
 * around a spike and draws a dip below zero on its way back up — a reading the
 * data never contained, on a chart whose whole job is to be believed. This one
 * cannot leave the interval between two neighbouring points.
 */
function curve(points: readonly (readonly [number, number])[]): string {
  if (points.length === 0) {
    return '';
  }

  if (points.length < 3) {
    return points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x},${y}`).join(' ');
  }

  // Slopes of the segments, then a tangent per point that is flattened
  // wherever the direction changes — which is what keeps the curve inside the
  // data.
  const slopes = points.slice(1).map(([x, y], index) => {
    const [px, py] = points[index];

    return x === px ? 0 : (y - py) / (x - px);
  });

  const tangents = points.map((_, index) => {
    if (index === 0) return slopes[0];
    if (index === points.length - 1) return slopes[slopes.length - 1];

    const before = slopes[index - 1];
    const after = slopes[index];

    return before * after <= 0 ? 0 : (before + after) / 2;
  });

  // Fritsch–Carlson: a tangent steeper than three times its segment makes the
  // curve leave the interval between the two points it joins. Without this the
  // line climbed above the top gridline on a sharp spike and drew a reading
  // higher than any the instrument reported.
  slopes.forEach((slope, index) => {
    if (slope === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      return;
    }

    const before = tangents[index] / slope;
    const after = tangents[index + 1] / slope;
    const distance = Math.hypot(before, after);

    if (distance > 3) {
      tangents[index] = ((3 / distance) * before) * slope;
      tangents[index + 1] = ((3 / distance) * after) * slope;
    }
  });

  let path = `M${points[0][0]},${points[0][1]}`;

  for (let index = 1; index < points.length; index += 1) {
    const [x0, y0] = points[index - 1];
    const [x1, y1] = points[index];
    const third = (x1 - x0) / 3;

    path += ` C${x0 + third},${y0 + tangents[index - 1] * third} ${x1 - third},${y1 - tangents[index] * third} ${x1},${y1}`;
  }

  return path;
}

/** The last bucket the instrument actually reported, for placing a label
 * beside a line whose final buckets are empty. */
function lastReading(values: readonly (number | null)[]): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];

    if (value !== null) {
      return value;
    }
  }

  return 0;
}
