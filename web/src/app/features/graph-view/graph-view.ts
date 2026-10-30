import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AsyncPipe, DecimalPipe } from '@angular/common';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { BehaviorSubject, combineLatest, distinctUntilChanged, map, skip } from 'rxjs';

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

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Layout {
  readonly nodes: PlacedNode[];
  readonly edges: PlacedEdge[];
  /** Who each node shares an edge with, so hovering one can pick out the part
   * of the map it belongs to. */
  readonly neighbours: ReadonlyMap<string, ReadonlySet<string>>;
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
/** How far the entry marker reaches out of the node it points at, and at what
 * angle above the horizontal. Above, because straight in from the left is
 * where the arrivals now fan to, and a dashed stub landing under a real
 * arrowhead reads as one confused edge rather than two facts. */
const ENTRY_REACH = 35;
const ENTRY_ANGLE = 70;
const FRAME_PAD = 8;

const COLUMN = 260;
const ROW = 110;
const MARGIN = { x: 130, y: 70 };
/** How far apart, in radians, two edges leaving or meeting the same node are
 * set, and the widest the whole fan is allowed to open to. */
const FAN_STEP = 0.38;
const FAN_ARC = 1.7;
/** The least room, in svg units, to leave between two of them on the rim. */
const MIN_GAP = 13;
/** How far an edge is bowed aside for each column it passes over. */
const BOW = 70;
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
          <svg #svg [attr.viewBox]="frozen ?? layout.viewBox" role="img"
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

            @let hovered = hovered$ | async;

            @for (placed of layout.edges; track placed.edge.source + '>' + placed.edge.target) {
              @let touches = !hovered || placed.edge.source === hovered || placed.edge.target === hovered;

              <path
                class="edge"
                [class.failing]="placed.failing"
                [class.lit]="hovered && touches"
                [class.faded]="hovered && !touches"
                [attr.d]="placed.path"
                [attr.stroke-width]="placed.width"
                marker-end="url(#arrow)"
              />
              <text
                class="edge-label"
                [class.faded]="hovered && !touches"
                [attr.x]="placed.labelX"
                [attr.y]="placed.labelY"
              >
                {{ placed.edge.calls | number }}
              </text>
            }

            @for (node of layout.nodes; track node.id) {
              <g
                class="node"
                [class.failing]="node.failing"
                [class.moving]="node.id === moving?.id"
                [class.faded]="!lit(layout, node, hovered)"
                [attr.transform]="'translate(' + node.x + ',' + node.y + ')'"
                (pointerdown)="grabNode($event, node, layout.viewBox)"
                (pointerenter)="highlight(node.id)"
                (pointerleave)="highlight(null)"
                (focus)="highlight(node.id)"
                (blur)="highlight(null)"
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
                  <path
                    class="entry"
                    [attr.d]="'M' + (-node.r - 26) + ' 0 H' + (-node.r - 6)"
                    [attr.transform]="'rotate(' + entryAngle + ')'"
                    marker-end="url(#arrow)"
                  />
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
            @if ((touched$ | async) === true) {
              <button mat-icon-button type="button" aria-label="Put the map back as it was laid out" matTooltip="Reset" (click)="reset()">
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
      /* Dragging a node otherwise sweeps a text selection across every label
         it passes, and the map ends the gesture highlighted blue. */
      user-select: none;
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

    /* Hovering a service picks out the part of the map it belongs to. The
       dashes travel source to target, which is the one thing an arrowhead at
       the far end says only once and only if you look for it. */
    .edge.lit {
      opacity: 0.95;
      /* Long dashes and short gaps: an edge is drawn several units wide, and a
         square dash on a 6px stroke reads as a row of blocks rather than as a
         line that is moving. */
      stroke-dasharray: 16 7;
      stroke-linecap: round;
      animation: flow 900ms linear infinite;
    }

    @keyframes flow {
      to {
        stroke-dashoffset: -23;
      }
    }

    .edge.faded {
      opacity: 0.07;
    }

    .node.faded {
      opacity: 0.22;
    }

    .edge-label.faded {
      opacity: 0.12;
    }

    .edge,
    .node,
    .edge-label {
      transition: opacity 140ms ease;
    }

    @media (prefers-reduced-motion: reduce) {
      .edge.lit {
        stroke-dasharray: none;
        animation: none;
      }

      .edge,
      .node,
      .edge-label {
        transition: none;
      }
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

    /* A label that lands on a stroke or a circle is unreadable without this,
       and with enough services some of them always will. paint-order is what
       puts the halo under the glyphs instead of over them. */
    .edge-label,
    .node .label {
      paint-order: stroke;
      stroke: var(--surface);
      stroke-width: 3px;
      stroke-linejoin: round;
    }

    .entry {
      stroke: var(--text-dim);
      stroke-width: 1.5;
      stroke-dasharray: 3 3;
      fill: none;
    }

    .node {
      /* Grab rather than pointer: a node is draggable as well as clickable,
         and the cursor is the only thing that says so. */
      cursor: grab;
    }

    .node.moving {
      cursor: grabbing;
    }

    /* A node is focusable because it is a link, and pressing on one to drag it
       focuses it — which drew a ring around whatever you were moving. The ring
       is for the keyboard, which is what :focus-visible already means
       everywhere except on an SVG element in Chrome. */
    .node:focus:not(:focus-visible) {
      outline: none;
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

  /**
   * Where the user has dragged nodes to.
   *
   * View state like the pan and the zoom, and for the same reasons — except
   * that it is keyed by node id rather than by position, so a node keeps where
   * it was put across a refresh or a change of time range. An arrangement
   * someone made to read a particular shape survives the data moving under it.
   */
  private readonly moved$$ = new BehaviorSubject<ReadonlyMap<string, Point>>(new Map());

  protected readonly layout$ = combineLatest([this.store.graph$, this.moved$$]).pipe(
    map(([graph, moved]) => layout(graph, moved)),
  );

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
   * reset button is worth the space. */
  protected readonly touched$ = combineLatest([this.view$$, this.moved$$]).pipe(
    map(
      ([view, moved]) =>
        moved.size > 0 || view.scale !== HOME.scale || view.x !== HOME.x || view.y !== HOME.y,
    ),
  );

  /** Set while a drag is in progress, read by the template for the cursor. */
  protected panning = false;

  protected readonly entryAngle = ENTRY_ANGLE;

  /**
   * The node under the pointer, which is the one thing that makes a busy map
   * readable: everything it does not touch is pushed into the background for
   * as long as you are looking at it.
   */
  private readonly hovered$$ = new BehaviorSubject<string | null>(null);
  protected readonly hovered$ = this.hovered$$.asObservable();

  /** Ignored mid-drag: the pointer is busy carrying a node, and the nodes it
   * passes over are not being looked at. */
  protected highlight(id: string | null): void {
    if (this.moving) {
      return;
    }

    this.hovered$$.next(id);
  }

  /** Whether a node keeps its colour: the hovered one, and whatever it talks
   * to. Everything else fades. */
  protected lit(layout: Layout, node: PlacedNode, hovered: string | null): boolean {
    return !hovered || node.id === hovered || (layout.neighbours.get(hovered)?.has(node.id) ?? false);
  }

  /**
   * The frame as it was when a node drag began, or null when none is running.
   *
   * The viewBox is measured from what is drawn, so moving a node resizes it,
   * and resizing it rescales everything inside — the node slid out from under
   * the pointer that was dragging it, faster the closer it got to an edge.
   * Holding the frame still for the length of the gesture makes the node
   * follow the pointer exactly; it catches up on release.
   */
  protected frozen: string | null = null;

  /** Where the pointer went down, and whether it has travelled far enough to be
   * a drag rather than a click on a node. */
  private from: { x: number; y: number } | null = null;
  private travelled = 0;

  /**
   * The node being dragged: which one, where it was when the drag started, and
   * where the pointer was. Both origins are kept rather than accumulating
   * deltas, so the node tracks the pointer exactly instead of drifting by the
   * slop it was allowed before the gesture counted as a drag.
   *
   * Null while the drag is panning the map instead.
   */
  protected moving: { id: string; at: Point; pointer: Point } | null = null;

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

  /**
   * Start dragging one node rather than the whole map.
   *
   * The layered layout is right about who calls whom and says nothing about
   * what you happen to be looking for, so being able to pull one service out
   * of the pile is worth the gesture. It stops propagating because the svg
   * underneath would otherwise begin a pan with the same pointer.
   */
  protected grabNode(event: PointerEvent, node: PlacedNode, viewBox: string): void {
    event.stopPropagation();

    this.travelled = 0;
    this.frozen = viewBox;
    this.from = { x: event.clientX, y: event.clientY };
    this.moving = {
      id: node.id,
      at: { x: node.x, y: node.y },
      pointer: { x: event.clientX, y: event.clientY },
    };
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

    if (this.moving) {
      // A node is positioned in the layout's own coordinates, and the pointer
      // moves in the page's, with the viewBox fit and the current zoom between
      // them: `perPixel` undoes the first, the scale the second.
      const moving = this.moving;
      const at = {
        x: moving.at.x + (event.clientX - moving.pointer.x) / perPixel / view.scale,
        y: moving.at.y + (event.clientY - moving.pointer.y) / perPixel / view.scale,
      };

      this.moved$$.next(new Map(this.moved$$.value).set(moving.id, at));

      return;
    }

    this.view$$.next({ ...view, x: view.x + dx / perPixel, y: view.y + dy / perPixel });
  }

  protected release(): void {
    this.panning = false;
    this.from = null;
    this.moving = null;
    this.frozen = null;
  }

  /** Back to the layout as it comes out of the data: the grid, unzoomed and
   * unpanned, with every node the user moved put back. */
  protected reset(): void {
    this.view$$.next(HOME);
    this.moved$$.next(new Map());
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
 * Where one edge of several meets a circle.
 *
 * Every edge used to leave from the same point and arrive at the same one, so
 * three calls out of one service left as a single ribbon and only came apart
 * halfway across. Spreading them over an arc makes three calls read as three;
 * ordering that arc by where the other end sits keeps them from crossing on
 * the way out.
 */
function anchor(node: PlacedNode, index: number, count: number, side: 1 | -1, pad: number) {
  const r = node.r + pad;
  // An angle buys less room on a small circle than on a large one, and the
  // quiet services are the small ones: two arrowheads into a 20px node landed
  // on top of each other. The fan opens by whichever is wider, a fixed angle
  // or the angle that leaves MIN_GAP between neighbours on this rim.
  const gap = Math.max(FAN_STEP, MIN_GAP / r);
  const spread = Math.min(FAN_ARC, gap * Math.max(0, count - 1));
  const angle = count > 1 ? spread * (index / (count - 1) - 0.5) : 0;

  return { x: node.x + side * r * Math.cos(angle), y: node.y + r * Math.sin(angle) };
}

/**
 * Layered left-to-right, not force-directed.
 *
 * A physics simulation on a graph this size spends its time settling and lands
 * somewhere different every reload, which makes the picture unreadable as a
 * thing you return to. Depth from the entry points puts callers left of what
 * they call, and the layout is the same every time for the same data.
 *
 * `moved` overrides the grid for nodes the user has dragged. It is applied
 * here rather than on top of a finished layout so that everything derived from
 * a position — which rim an edge leaves by, how far it bows, where the frame
 * ends — is derived from where the node actually is.
 */
function layout(graph: ServiceGraph, moved: ReadonlyMap<string, Point> = new Map()): Layout {
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
      const at = moved.get(id);

      placed.set(id, {
        id,
        spans: node.spans,
        errors: node.errors,
        x: at?.x ?? MARGIN.x + depth * COLUMN,
        y: at?.y ?? MARGIN.y + (index + (tallest - ids.length) / 2) * ROW,
        r,
        failing: node.spans > 0 && node.errors / node.spans > ERROR_THRESHOLD,
        entry: entries.has(id),
      });
    });
  }

  const busiestEdge = Math.max(...graph.edges.map((edge) => edge.calls), 1);

  // Which slot each edge takes on the rim of the node it leaves and of the one
  // it meets. Sorted by where the far end sits, so the fan comes out in the
  // same order it arrives in and no two edges have to cross to reach it.
  const departures = new Map<string, GraphEdge[]>();
  const arrivals = new Map<string, GraphEdge[]>();
  const row = (id: string) => placed.get(id)?.y ?? 0;

  for (const edge of graph.edges) {
    if (edge.source === edge.target || !placed.has(edge.source) || !placed.has(edge.target)) {
      continue;
    }

    departures.set(edge.source, [...(departures.get(edge.source) ?? []), edge]);
    arrivals.set(edge.target, [...(arrivals.get(edge.target) ?? []), edge]);
  }

  for (const list of departures.values()) {
    list.sort((a, b) => row(a.target) - row(b.target));
  }

  for (const list of arrivals.values()) {
    list.sort((a, b) => row(a.source) - row(b.source));
  }

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

      const out = departures.get(edge.source) ?? [];
      const into = arrivals.get(edge.target) ?? [];
      const from = anchor(source, out.indexOf(edge), out.length, 1, 0);
      const to = anchor(target, into.indexOf(edge), into.length, -1, 9);

      // An edge that skips a column is drawn straight over whatever stands in
      // the middle: on production `musicbox-web` calling `microgamma-signaling`
      // crossed `musicbox-streamer` and looked like it ended there. Bowing it
      // clear per column skipped, away from the row it would cross, costs a
      // longer curve and buys an unambiguous one.
      const skipped = Math.max(0, Math.round((target.x - source.x) / COLUMN) - 1);
      const lift = skipped * BOW * (target.y <= source.y ? -1 : 1);
      const bend = (to.x - from.x) / 2;
      const c1 = { x: from.x + bend, y: from.y + lift };
      const c2 = { x: to.x - bend, y: to.y + lift };

      return {
        edge,
        path: `M${from.x} ${from.y} C${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`,
        width,
        failing,
        // The curve's own midpoint rather than the midpoint of the line between
        // its ends. With a bow those are different points, and the label sat on
        // whatever the edge had just arced around.
        labelX: (from.x + 3 * c1.x + 3 * c2.x + to.x) / 8,
        labelY: (from.y + 3 * c1.y + 3 * c2.y + to.y) / 8 - 7,
      };
    })
    .filter((edge): edge is PlacedEdge => edge !== null);

  const nodes = [...placed.values()];
  const looping = new Set(
    edges.filter((placed) => placed.edge.source === placed.edge.target).map((placed) => placed.edge.source),
  );

  const neighbours = new Map<string, Set<string>>();

  for (const placed of edges) {
    const { source, target } = placed.edge;

    neighbours.set(source, (neighbours.get(source) ?? new Set()).add(target));
    neighbours.set(target, (neighbours.get(target) ?? new Set()).add(source));
  }

  return { nodes, edges, neighbours, viewBox: frame(nodes, looping, edges) };
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
function frame(nodes: PlacedNode[], looping: ReadonlySet<string>, edges: PlacedEdge[]): string {
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

    lefts.push(node.x - half);
    rights.push(node.x + half);
    tops.push(node.y - node.r);
    bottoms.push(node.y + node.r + LABEL_DROP);

    if (node.entry) {
      // The marker leaves the node up and to the left, so it is the top of the
      // frame it threatens rather than only the side.
      const radians = (ENTRY_ANGLE * Math.PI) / 180;
      const reach = node.r + ENTRY_REACH;

      lefts.push(node.x - reach * Math.cos(radians));
      tops.push(node.y - reach * Math.sin(radians));
    }

    if (looping.has(node.id)) {
      const loop = node.r + 18;

      // The apex of the loop's cubic, and the label above it.
      tops.push(node.y - 0.2 * node.r - 1.5 * loop, node.y - loop - 25);
      lefts.push(node.x - loop);
      rights.push(node.x + loop);
    }
  }

  for (const edge of edges) {
    // A bowed edge reaches past both nodes it joins, and its label sits on the
    // apex of the bow. Both are drawn, so both belong inside the frame.
    tops.push(edge.labelY - 8);
    bottoms.push(edge.labelY + 12);
    lefts.push(edge.labelX - 16);
    rights.push(edge.labelX + 16);
  }

  const x = Math.min(...lefts) - FRAME_PAD;
  const y = Math.min(...tops) - FRAME_PAD;

  return `${x} ${y} ${Math.max(...rights) + FRAME_PAD - x} ${Math.max(...bottoms) + FRAME_PAD - y}`;
}
