import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AsyncPipe, DecimalPipe } from '@angular/common';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { BehaviorSubject, distinctUntilChanged, map, skip } from 'rxjs';

import { AppScope } from '../../core/app-scope';
import { GraphEdge, GraphStore, ServiceGraph } from '../../core/graph.store';
import { DEFAULT_RANGE, Range } from '../../core/services.store';
import { fromParams, sameRange } from '../../core/time-range';
import { DurationPipe } from '../../shared/duration-pipe';
import { PageHeader } from '../../shared/page-header';
import { TimeRangePicker } from '../../shared/time-range-picker';

interface PlacedNode {
  readonly id: string;
  readonly spans: number;
  readonly errors: number;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly failing: boolean;
  readonly entry: boolean;
}

interface PlacedEdge {
  readonly edge: GraphEdge;
  readonly path: string;
  readonly width: number;
  readonly failing: boolean;
  readonly labelX: number;
  readonly labelY: number;
}

interface Layout {
  readonly nodes: PlacedNode[];
  readonly edges: PlacedEdge[];
  /** Sized to what is drawn, not to the grid it was placed on. See [`frame`]. */
  readonly viewBox: string;
}

/** How the map is being looked at: a translation in the svg's own units and a
 * scale about the origin, applied in that order. */
interface View {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

const HOME: View = { x: 0, y: 0, scale: 1 };
const MIN_SCALE = 0.4;
const MAX_SCALE = 8;
/** Pointer travel, in client pixels, past which letting go is the end of a drag
 * rather than a click. */
const DRAG_SLOP = 5;

/** Where an event happened, in the coordinates the transform is applied in.
 * `getScreenCTM` rather than arithmetic on the bounding box, because it already
 * accounts for the viewBox fit, the page zoom and any transformed ancestor. */
function toUserSpace(event: { clientX: number; clientY: number }, svg: SVGSVGElement) {
  const ctm = svg.getScreenCTM();

  if (!ctm) {
    return null;
  }

  const point = svg.createSVGPoint();

  point.x = event.clientX;
  point.y = event.clientY;

  return point.matrixTransform(ctm.inverse());
}

/** Advance width of the 12px monospace a node label is set in, and how far its
 * baseline sits below the circle. */
const LABEL_ADVANCE = 7.2;
const LABEL_DROP = 20;
/** How far the entry marker reaches to the left of the node it points at. */
const ENTRY_REACH = 35;
const FRAME_PAD = 8;

const COLUMN = 260;
const ROW = 110;
const MARGIN = { x: 130, y: 70 };
/** Above this share of spans in error, a node or an edge is drawn as failing.
 * One percent rather than any error at all: a trace in a hundred going wrong is
 * a different fact from a service being down. */
const ERROR_THRESHOLD = 0.01;

@Component({
  selector: 'wt-graph-view',
  imports: [
    AsyncPipe,
    DecimalPipe,
    DurationPipe,
    RouterLink,
    PageHeader,
    TimeRangePicker,
    MatFormFieldModule,
    MatSelectModule,
    MatTooltipModule,
    MatButtonModule,
    MatIconModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <wt-page-header
      heading="Map"
      subtitle="Who calls whom, read from the spans themselves — an edge is a parent and a child that landed in different processes."
    >
      <mat-form-field subscriptSizing="dynamic" class="grouping">
        <mat-label>Group by</mat-label>
        <mat-select [value]="group$ | async" (selectionChange)="selectGrouping($event.value)">
          @for (option of groupings; track option.key) {
            <mat-option [value]="option.key">{{ option.label }}</mat-option>
          }
        </mat-select>
      </mat-form-field>

      <wt-time-range />
    </wt-page-header>

    @if (layout$ | async; as layout) {
      @if (layout.nodes.length) {
        <figure class="map" [class.panning]="panning">
          <!-- The gestures belong to the drawing, not to the card. On the card
               they also caught the zoom buttons, and a pointer capture taken on
               the way down meant the button never saw its own click. -->
          <svg #svg [attr.viewBox]="layout.viewBox" role="img"
               [attr.aria-label]="describe(layout)"
               (wheel)="zoom($event, $any(svg))"
               (pointerdown)="grab($event)"
               (pointermove)="drag($event, $any(svg))"
               (pointerup)="release()"
               (pointercancel)="release()">
            <defs>
              <!-- userSpaceOnUse: a marker scales with the stroke by default, so
                   the busiest edge - the one drawn thickest - also grew the
                   largest arrowhead, until the head was bigger than the node it
                   pointed at. The head says direction; the stroke says volume. -->
              <marker
                id="arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="9"
                markerHeight="9"
                markerUnits="userSpaceOnUse"
                orient="auto"
              >
                <path d="M0 0 L10 5 L0 10 z" class="arrow" />
              </marker>
            </defs>

            <!-- Everything drawn rides one transform. The viewBox stays the
                 layout's own size, so the arrowhead marker and the stroke
                 widths keep their meaning; zooming moves the content inside the
                 frame rather than redefining what a unit is. -->
            <g [attr.transform]="transform$ | async">

            @for (placed of layout.edges; track placed.edge.source + '>' + placed.edge.target) {
              <path
                class="edge"
                [class.failing]="placed.failing"
                [attr.d]="placed.path"
                [attr.stroke-width]="placed.width"
                marker-end="url(#arrow)"
              />
              <text class="edge-label" [attr.x]="placed.labelX" [attr.y]="placed.labelY">
                {{ placed.edge.calls | number }}
              </text>
            }

            @for (node of layout.nodes; track node.id) {
              <g
                class="node"
                [class.failing]="node.failing"
                [attr.transform]="'translate(' + node.x + ',' + node.y + ')'"
                (click)="openTraces(node.id)"
                [attr.tabindex]="0"
                (keydown.enter)="openTraces(node.id)"
                role="link"
                [attr.aria-label]="node.id + ', ' + node.spans + ' spans'"
                [matTooltip]="tooltip(node)"
              >
                @if (node.entry) {
                  <!-- A span whose parent never arrived: the start of a trace,
                       or a hop nobody instrumented. Marked rather than hidden. -->
                  <path class="entry" [attr.d]="'M' + (-node.r - 26) + ' 0 H' + (-node.r - 6)" marker-end="url(#arrow)" />
                }
                <circle [attr.r]="node.r" />
                <text class="label" [attr.y]="node.r + 16">{{ node.id }}</text>
              </g>
            }

            </g>
          </svg>

          <!-- The wheel and the drag are not discoverable, and neither is
               reachable from the keyboard. These are. -->
          <div class="controls fx-flex fx-gap-1">
            <button mat-icon-button type="button" aria-label="Zoom in" matTooltip="Zoom in" (click)="step(1.3, $any(svg))">
              <mat-icon>add</mat-icon>
            </button>
            <button mat-icon-button type="button" aria-label="Zoom out" matTooltip="Zoom out" (click)="step(1 / 1.3, $any(svg))">
              <mat-icon>remove</mat-icon>
            </button>
            @if ((moved$ | async) === true) {
              <button mat-icon-button type="button" aria-label="Fit the map to the frame" matTooltip="Fit" (click)="reset()">
                <mat-icon>fit_screen</mat-icon>
              </button>
            }
          </div>
        </figure>

        <!-- The table is the chart's twin, not a fallback: it carries the
             numbers the picture only ranks. -->
        <h2 class="sr-only">Calls between services</h2>
        <table>
          <caption class="sr-only">Every edge on the map</caption>
          <thead>
            <tr>
              <th scope="col">From</th>
              <th scope="col">To</th>
              <th scope="col" class="num">Calls</th>
              <th scope="col" class="num">Errors</th>
              <th scope="col" class="num">p95</th>
              <th scope="col">Kinds</th>
              <th scope="col"><span class="sr-only">Traces</span></th>
            </tr>
          </thead>
          <tbody>
            @for (edge of (graph$ | async)?.edges ?? []; track edge.source + '>' + edge.target) {
              <tr>
                <th scope="row" class="mono">{{ edge.source }}</th>
                <td class="mono">{{ edge.target }}</td>
                <td class="num">{{ edge.calls | number }}</td>
                <td class="num" [class.bad]="edge.errors > 0">{{ edge.errors | number }}</td>
                <td class="num">{{ edge.p95Ms * 1e6 | duration }}</td>
                <td class="dim">{{ edge.kinds }}</td>
                <td>
                  <a [routerLink]="scope.link('traces')" [queryParams]="{ service: edge.target }">traces</a>
                </td>
              </tr>
            }
            @for (entry of (graph$ | async)?.entries ?? []; track entry.target) {
              <tr>
                <th scope="row" class="dim">entry point</th>
                <td class="mono">{{ entry.target }}</td>
                <td class="num">{{ entry.calls | number }}</td>
                <td class="num" [class.bad]="entry.errors > 0">{{ entry.errors | number }}</td>
                <td class="num">{{ entry.p95Ms * 1e6 | duration }}</td>
                <td class="dim">{{ entry.kinds }}</td>
                <td>
                  <a [routerLink]="scope.link('traces')" [queryParams]="{ service: entry.target }">traces</a>
                </td>
              </tr>
            }
          </tbody>
        </table>
      } @else {
        <div class="nothing-here">
          <span>
            No linked spans in this window. A map needs propagated context — a service
            calling another without passing the trace header is two islands, not an edge.
          </span>
        </div>
      }
    }
  `,
  styles: `
    .map {
      position: relative;
      /* A frame, not a canvas that grows with the graph.
         The layout gives every node a row of its own, so a height that followed
         it put a thirty-service map two thousand pixels down the page and the
         first node off the top of the screen. The whole graph is scaled into
         this box instead, and getting closer is what the zoom is for. */
      block-size: clamp(20rem, 60vh, 45rem);
      margin: 0 0 var(--fx-m);
      padding: var(--fx-s);
      border: 1px solid var(--line);
      border-radius: var(--mat-sys-corner-medium);
      background: var(--surface);
      /* Hidden rather than auto: the content moves under a fixed frame now, and
         a scrollbar that appears when you drag is the old behaviour fighting
         the new one. */
      overflow: hidden;
      cursor: grab;
      /* Otherwise a touch drag scrolls the page instead of the map. */
      touch-action: none;
    }

    .map.panning {
      cursor: grabbing;
    }

    .controls {
      position: absolute;
      inset-block-start: var(--fx-2xs);
      inset-inline-end: var(--fx-2xs);
      opacity: 0.55;
      transition: opacity 120ms ease;
    }

    .map:hover .controls,
    .controls:focus-within {
      opacity: 1;
    }

    svg {
      display: block;
      /* Fills the frame; the viewBox and the default xMidYMid meet do the
         fitting, so the graph arrives whole and centred whatever its shape. */
      inline-size: 100%;
      block-size: 100%;
    }

    .edge {
      fill: none;
      stroke: var(--text-dim);
      opacity: 0.55;
    }

    .edge.failing {
      stroke: var(--error);
      opacity: 0.9;
    }

    .arrow {
      fill: var(--text-dim);
    }

    .edge-label {
      fill: var(--text-dim);
      font-size: 11px;
      text-anchor: middle;
      font-variant-numeric: tabular-nums;
    }

    .entry {
      stroke: var(--text-dim);
      stroke-width: 1.5;
      stroke-dasharray: 3 3;
      fill: none;
    }

    .node {
      cursor: pointer;
    }

    .node circle {
      fill: color-mix(in srgb, var(--accent) 22%, var(--surface));
      stroke: var(--accent);
      stroke-width: 1.5;
    }

    .node.failing circle {
      fill: color-mix(in srgb, var(--error) 22%, var(--surface));
      stroke: var(--error);
    }

    .node:hover circle,
    .node:focus-visible circle {
      fill: color-mix(in srgb, var(--accent) 38%, var(--surface));
    }

    .node .label {
      fill: var(--text);
      font-size: 12px;
      text-anchor: middle;
      font-family: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace;
    }

    .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    .bad {
      color: var(--error);
    }

    .grouping {
      min-width: 10rem;
    }
  `,
})
export class GraphView implements OnInit {
  private readonly store = inject(GraphStore);
  protected readonly scope = inject(AppScope);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly groupings = [
    { key: 'service', label: 'Service' },
    { key: 'app', label: 'App' },
    { key: 'instance', label: 'Instance' },
    { key: 'role', label: 'Role' },
    { key: 'host', label: 'Host' },
    { key: 'environment', label: 'Environment' },
  ];

  protected readonly graph$ = this.store.graph$;
  protected readonly range$ = this.store.range$;
  protected readonly group$ = this.store.group$;
  protected readonly layout$ = this.store.graph$.pipe(map((graph) => layout(graph)));

  /**
   * Where the map is being looked at from.
   *
   * View state, so it lives here rather than in the store: it is not a fact
   * about the system, nothing else reads it, and it should not survive a
   * reload. The layout is laid out once at a fixed size and this moves over it.
   */
  private readonly view$$ = new BehaviorSubject<View>(HOME);

  protected readonly transform$ = this.view$$.pipe(
    map((view) => `translate(${view.x} ${view.y}) scale(${view.scale})`),
  );

  /** Whether there is anything to go back from, which is what decides if the
   * fit button is worth the space. */
  protected readonly moved$ = this.view$$.pipe(
    map((view) => view.scale !== HOME.scale || view.x !== HOME.x || view.y !== HOME.y),
  );

  /** Set while a drag is in progress, read by the template for the cursor. */
  protected panning = false;

  /** Where the pointer went down, and whether it has travelled far enough to be
   * a drag rather than a click on a node. */
  private from: { x: number; y: number } | null = null;
  private travelled = 0;

  constructor() {
    // Switching app changes a path parameter, and Angular reuses the component
    // rather than recreating it — so nothing would re-run on its own. skip(1)
    // because the first emission is the scope this page just loaded under.
    this.scope.app$
      .pipe(skip(1), takeUntilDestroyed())
      .subscribe(() => {
        this.store.dispatch('load');
      });

    // The window lives in the URL, so a change to it arrives as a navigation,
    // including one from the back button.
    this.route.queryParamMap
      .pipe(
        map((params) => fromParams(params) ?? DEFAULT_RANGE),
        distinctUntilChanged((a, b) => sameRange(a, b)),
        takeUntilDestroyed(),
      )
      .subscribe((range) => {
        this.store.dispatch('selectRange', range);
        this.store.dispatch('load');
      });
  }

  ngOnInit(): void {
    this.store.dispatch('load');
  }

  protected selectGrouping(group: string): void {
    this.store.dispatch('selectGrouping', group);
    this.store.dispatch('load');
  }

  protected openTraces(service: string): void {
    // A drag that ends over a node still fires a click. Opening a page because
    // someone let go of the mouse in the wrong place is the kind of thing that
    // makes a map feel broken rather than draggable.
    if (this.travelled > DRAG_SLOP) {
      return;
    }

    this.router.navigate(this.scope.link('traces'), { queryParams: { service } });
  }

  /**
   * Zoom about the pointer, so the thing under the cursor stays under it.
   *
   * Zooming about the centre is what makes a map feel like it is fighting you:
   * you point at the node you want a closer look at and it slides away.
   */
  protected zoom(event: WheelEvent, svg: SVGSVGElement): void {
    event.preventDefault();

    const at = toUserSpace(event, svg);

    if (!at) {
      return;
    }

    // Exponential in the delta, so a trackpad's many small events and a
    // mouse wheel's few large ones travel the same distance per gesture.
    this.scaleAbout(at, Math.exp(-event.deltaY / 400));
  }

  /** The buttons, which zoom about the middle of the frame because there is no
   * pointer to zoom about. */
  protected step(by: number, svg: SVGSVGElement): void {
    const box = svg.viewBox.baseVal;

    this.scaleAbout({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, by);
  }

  protected grab(event: PointerEvent): void {
    this.panning = true;
    this.travelled = 0;
    this.from = { x: event.clientX, y: event.clientY };
  }

  protected drag(event: PointerEvent, svg: SVGSVGElement): void {
    if (!this.from) {
      return;
    }

    const perPixel = svg.getScreenCTM()?.a;

    if (!perPixel) {
      return;
    }

    const dx = event.clientX - this.from.x;
    const dy = event.clientY - this.from.y;

    const before = this.travelled;

    this.travelled += Math.abs(dx) + Math.abs(dy);
    this.from = { x: event.clientX, y: event.clientY };

    // Captured only once this is a drag, never on the way down. Capturing on
    // pointerdown retargets the pointer stream to the svg, and with it the
    // click the browser would otherwise dispatch on what was pressed — so
    // every node stopped opening its traces, and so did the zoom buttons.
    if (before <= DRAG_SLOP && this.travelled > DRAG_SLOP) {
      svg.setPointerCapture(event.pointerId);
    }

    const view = this.view$$.value;

    this.view$$.next({ ...view, x: view.x + dx / perPixel, y: view.y + dy / perPixel });
  }

  protected release(): void {
    this.panning = false;
    this.from = null;
  }

  protected reset(): void {
    this.view$$.next(HOME);
  }

  /**
   * Scale by `by`, keeping the content under `at` where it is.
   *
   * `at` is in the svg's own coordinates, which is the space the transform is
   * applied in — so the content point under it is `(at - translate) / scale`,
   * and holding it still is a matter of solving for the new translate.
   */
  private scaleAbout(at: { x: number; y: number }, by: number): void {
    const view = this.view$$.value;
    const scale = Math.min(Math.max(view.scale * by, MIN_SCALE), MAX_SCALE);

    if (scale === view.scale) {
      return;
    }

    const ratio = scale / view.scale;

    this.view$$.next({
      scale,
      x: at.x - (at.x - view.x) * ratio,
      y: at.y - (at.y - view.y) * ratio,
    });
  }

  protected tooltip(node: PlacedNode): string {
    const errors = node.errors ? `, ${node.errors} in error` : '';

    return `${node.id}: ${node.spans.toLocaleString()} spans${errors}`;
  }

  protected describe(view: Layout): string {
    return `${view.nodes.length} services, ${view.edges.length} call paths between them.`;
  }
}

/**
 * Layered left-to-right, not force-directed.
 *
 * A physics simulation on a graph this size spends its time settling and lands
 * somewhere different every reload, which makes the picture unreadable as a
 * thing you return to. Depth from the entry points puts callers left of what
 * they call, and the layout is the same every time for the same data.
 */
function layout(graph: ServiceGraph): Layout {
  const between = graph.edges.filter((edge) => edge.source !== edge.target);
  const depths = new Map<string, number>();

  for (const node of graph.nodes) {
    depths.set(node.id, 0);
  }

  // Relaxed rather than recursed: a cycle is a legitimate shape here (two
  // services calling each other) and would never terminate a depth-first walk.
  // Each pass can only push a node right, and nothing moves after as many
  // passes as there are nodes.
  for (let pass = 0; pass < graph.nodes.length; pass++) {
    let moved = false;

    for (const edge of between) {
      const source = depths.get(edge.source) ?? 0;
      const target = depths.get(edge.target) ?? 0;

      if (target <= source) {
        depths.set(edge.target, source + 1);
        moved = true;
      }
    }

    if (!moved) {
      break;
    }
  }

  const columns = new Map<number, string[]>();

  for (const node of [...graph.nodes].sort((a, b) => b.spans - a.spans)) {
    const depth = depths.get(node.id) ?? 0;

    columns.set(depth, [...(columns.get(depth) ?? []), node.id]);
  }

  const entries = new Set(graph.entries.map((entry) => entry.target));
  const tallest = Math.max(...[...columns.values()].map((column) => column.length), 1);
  const spans = graph.nodes.map((node) => node.spans);
  const busiest = Math.max(...spans, 1);

  const placed = new Map<string, PlacedNode>();

  for (const [depth, ids] of columns) {
    ids.forEach((id, index) => {
      const node = graph.nodes.find((candidate) => candidate.id === id);

      if (!node) {
        return;
      }

      // Area, not radius, carries the count: a node with ten times the spans
      // should look ten times the node, and radius would make it a hundred.
      const r = 14 + 26 * Math.sqrt(node.spans / busiest);

      placed.set(id, {
        id,
        spans: node.spans,
        errors: node.errors,
        x: MARGIN.x + depth * COLUMN,
        y: MARGIN.y + (index + (tallest - ids.length) / 2) * ROW,
        r,
        failing: node.spans > 0 && node.errors / node.spans > ERROR_THRESHOLD,
        entry: entries.has(id),
      });
    });
  }

  const busiestEdge = Math.max(...graph.edges.map((edge) => edge.calls), 1);

  const edges = graph.edges
    .map((edge) => {
      const source = placed.get(edge.source);
      const target = placed.get(edge.target);

      if (!source || !target) {
        return null;
      }

      // Log, because call counts span orders of magnitude and a linear width
      // would draw every edge but the busiest as a hairline.
      const width = 1 + 5 * (Math.log1p(edge.calls) / Math.log1p(busiestEdge));
      const failing = edge.calls > 0 && edge.errors / edge.calls > ERROR_THRESHOLD;

      if (edge.source === edge.target) {
        // A service that calls itself is a real hop — a renderer talking to the
        // process it shares a name with — so it gets a loop rather than being
        // filtered out of existence.
        const loop = source.r + 18;

        return {
          edge,
          path: `M${source.x - source.r * 0.6} ${source.y - source.r * 0.8}
                 C${source.x - loop} ${source.y - loop * 2},
                  ${source.x + loop} ${source.y - loop * 2},
                  ${source.x + source.r * 0.6} ${source.y - source.r * 0.8}`,
          width,
          failing,
          labelX: source.x,
          labelY: source.y - loop - 14,
        };
      }

      const from = { x: source.x + source.r, y: source.y };
      const to = { x: target.x - target.r - 8, y: target.y };
      const bend = (to.x - from.x) / 2;

      return {
        edge,
        path: `M${from.x} ${from.y} C${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`,
        width,
        failing,
        labelX: (from.x + to.x) / 2,
        labelY: (from.y + to.y) / 2 - 8,
      };
    })
    .filter((edge): edge is PlacedEdge => edge !== null);

  const nodes = [...placed.values()];
  const looping = new Set(
    edges.filter((placed) => placed.edge.source === placed.edge.target).map((placed) => placed.edge.source),
  );

  return { nodes, edges, viewBox: frame(nodes, looping) };
}

/**
 * The box that holds everything drawn.
 *
 * Taken from the drawing rather than from the grid it was laid out on. The
 * grid's margins were a guess at how far past a node its decorations reach, and
 * the guess was wrong for a busy service that calls itself: its loop rises with
 * its radius, and on the top row the loop and its label went above the frame.
 * That was invisible while the svg was allowed to overflow — the arc simply
 * drew outside the card — and became a clipped arc the moment the map could
 * pan, which is the honest rendering of a frame that was always too small.
 */
function frame(nodes: PlacedNode[], looping: ReadonlySet<string>): string {
  if (nodes.length === 0) {
    return '0 0 1 1';
  }

  const lefts: number[] = [];
  const rights: number[] = [];
  const tops: number[] = [];
  const bottoms: number[] = [];

  for (const node of nodes) {
    // The label is centred under the node and is the widest thing about a small
    // one. Monospace, so its width is countable rather than measurable.
    const half = Math.max(node.r, (node.id.length * LABEL_ADVANCE) / 2);

    lefts.push(node.x - half, node.x - node.r - (node.entry ? ENTRY_REACH : 0));
    rights.push(node.x + half);
    tops.push(node.y - node.r);
    bottoms.push(node.y + node.r + LABEL_DROP);

    if (looping.has(node.id)) {
      const loop = node.r + 18;

      // The apex of the loop's cubic, and the label above it.
      tops.push(node.y - 0.2 * node.r - 1.5 * loop, node.y - loop - 25);
      lefts.push(node.x - loop);
      rights.push(node.x + loop);
    }
  }

  const x = Math.min(...lefts) - FRAME_PAD;
  const y = Math.min(...tops) - FRAME_PAD;

  return `${x} ${y} ${Math.max(...rights) + FRAME_PAD - x} ${Math.max(...bottoms) + FRAME_PAD - y}`;
}
