import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export interface SparkPoint {
  readonly bucket: string;
  readonly value: number;
}

const VIEW = { width: 240, height: 44, pad: 3 };

/**
 * One metric's shape, small enough to sit on a card.
 *
 * No axes, no labels, no hover: the card carries the current reading in
 * figures, and this answers the question figures cannot — is it climbing,
 * flat, spiky, or did it stop reporting. Anything more belongs in the chart
 * this card links to.
 */
@Component({
  selector: 'wt-sparkline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (path(); as d) {
      <svg [attr.viewBox]="viewBox" preserveAspectRatio="none" role="img" [attr.aria-label]="label()">
        <path class="area" [attr.d]="area()" />
        <path class="line" [attr.d]="d" />
        @if (last(); as point) {
          <circle class="head" [attr.cx]="point.x" [attr.cy]="point.y" r="2" />
        }
      </svg>
    } @else {
      <p class="empty">no data in this window</p>
    }
  `,
  styles: `
    :host {
      display: block;
    }

    svg {
      display: block;
      width: 100%;
      height: 2.75rem;
      overflow: visible;
    }

    .line {
      fill: none;
      stroke: var(--accent);
      stroke-width: 1.5;
      stroke-linejoin: round;
      stroke-linecap: round;
      /* The viewBox is stretched to the card's width, which would stretch the
         stroke with it; this keeps the line the same weight on every card. */
      vector-effect: non-scaling-stroke;
    }

    .area {
      fill: color-mix(in srgb, var(--accent) 14%, transparent);
      stroke: none;
    }

    .head {
      fill: var(--accent);
      vector-effect: non-scaling-stroke;
    }

    .empty {
      margin: 0;
      height: 2.75rem;
      display: flex;
      align-items: center;
      color: var(--text-dim);
      font-size: var(--fx-typography--2);
    }
  `,
})
export class Sparkline {
  readonly points = input<SparkPoint[]>([]);
  readonly label = input('');

  protected readonly viewBox = `0 0 ${VIEW.width} ${VIEW.height}`;

  /**
   * Plotted against time rather than against position in the array, so a gap
   * in reporting shows as a gap in slope instead of being closed up.
   */
  private readonly plotted = computed(() => {
    const points = this.points();

    if (points.length === 0) {
      return [];
    }

    const times = points.map((point) => Date.parse(point.bucket.replace(' ', 'T') + 'Z'));
    const values = points.map((point) => point.value);
    const start = times[0];
    const span = Math.max(times[times.length - 1] - start, 1);
    const top = Math.max(...values);
    const bottom = Math.min(...values, 0);
    // A series that never moves is still a fact worth drawing; without this it
    // would divide by zero and vanish.
    const range = top - bottom || 1;
    const usable = VIEW.height - VIEW.pad * 2;

    return points.map((point, index) => ({
      x: points.length === 1 ? VIEW.width : ((times[index] - start) / span) * VIEW.width,
      y: VIEW.pad + usable - ((point.value - bottom) / range) * usable,
    }));
  });

  protected readonly path = computed(() => {
    const plotted = this.plotted();

    if (plotted.length === 0) {
      return '';
    }

    if (plotted.length === 1) {
      return `M0 ${plotted[0].y}L${VIEW.width} ${plotted[0].y}`;
    }

    return plotted.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join('');
  });

  protected readonly area = computed(() => {
    const line = this.path();

    if (!line) {
      return '';
    }

    const plotted = this.plotted();
    const first = plotted[0];
    const last = plotted[plotted.length - 1];
    const lastX = plotted.length === 1 ? VIEW.width : last.x;

    return `${line}L${lastX} ${VIEW.height}L${first.x} ${VIEW.height}Z`;
  });

  protected readonly last = computed(() => this.plotted().at(-1) ?? null);
}
