import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AsyncPipe, DecimalPipe } from '@angular/common';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { BehaviorSubject, distinctUntilChanged, map, shareReplay, skip, tap } from 'rxjs';
import { Graph, layout as runDagre } from '@dagrejs/dagre';
import { Background, ConnectionSettings, Edge, Node, Vflow, VflowComponent } from 'ngx-vflow';

import { AppScope } from '../../core/app-scope';
import { GraphEdge, GraphStore, ServiceGraph } from '../../core/graph.store';
import { DEFAULT_RANGE } from '../../core/services.store';
import { fromParams, sameRange } from '../../core/time-range';
import { DurationPipe } from '../../shared/duration-pipe';
import { PageHeader } from '../../shared/page-header';
import { TimeRangePicker } from '../../shared/time-range-picker';

/** What a node's template is handed. The flow library owns the position; this
 * is everything about the service that decides how it is drawn. */
interface NodeData {
  readonly id: string;
  readonly spans: number;
  readonly errors: number;
  readonly r: number;
  readonly failing: boolean;
  readonly entry: boolean;
}

interface EdgeData {
  readonly edge: GraphEdge;
  readonly width: number;
  readonly failing: boolean;
}

interface Flow {
  readonly nodes: Node[];
  readonly edges: Edge[];
  /** Who each node shares an edge with, so hovering one can pick out the part
   * of the map it belongs to. */
  readonly neighbours: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Left-to-right layered layout. `ranksep` is generous because an edge carries
 * a call count in the middle of it and wants somewhere to put it. */
const DAGRE = { rankdir: 'LR', nodesep: 48, ranksep: 150, marginx: 24, marginy: 24 };

/** Room under a circle for the service name, reserved in the box dagre spaces
 * so two labels in the same rank cannot collide. */
const LABEL_SPACE = 34;
/** Advance width of the 12px monospace the label is set in. Monospace, so its
 * width is countable rather than measurable. */
const LABEL_ADVANCE = 7.2;

/** Above this share of spans in error, a node or an edge is drawn as failing.
 * One percent rather than any error at all: a trace in a hundred going wrong is
 * a different fact from a service being down. */
const ERROR_THRESHOLD = 0.01;

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 6;

@Component({
  selector: 'wt-graph-view',
  imports: [
    AsyncPipe,
    DecimalPipe,
    DurationPipe,
    RouterLink,
    PageHeader,
    TimeRangePicker,
    Vflow,
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

    @if (flow$ | async; as flow) {
      @if (flow.nodes.length) {
        @let hovered = hovered$ | async;

        <figure class="map" #frame>
          <vflow
            view="auto"
            [nodes]="flow.nodes"
            [edges]="flow.edges"
            [minZoom]="minZoom"
            [maxZoom]="maxZoom"
            [entitiesSelectable]="false"
            [background]="background"
            [connection]="connection"
            (nodeDrag)="onDrag()"
            (nodeDragEnd)="onDragEnd()"
          >
            <!-- The edge is ours: the library hands over the path it routed and
                 the marker it registered, and everything that says what the
                 edge *means* — how busy, whether it is failing, whether you are
                 looking at it — stays in this stylesheet. -->
            <ng-template let-ctx edge>
              @let data = $any(ctx.data());
              @let touches =
                !hovered || data.edge.source === hovered || data.edge.target === hovered;

              <svg:path
                class="edge"
                [class.failing]="data.failing"
                [class.lit]="hovered && touches"
                [class.faded]="hovered && !touches"
                [attr.d]="ctx.path()"
                [attr.stroke-width]="data.width"
                [attr.marker-end]="ctx.markerEnd()"
              />
            </ng-template>

            <ng-template let-ctx edgeLabelHtml>
              @let label = $any(ctx.label).data;
              @let lit =
                !hovered || label.edge.source === hovered || label.edge.target === hovered;

              <div class="edge-label" [class.faded]="hovered && !lit">
                {{ label.edge.calls | number }}
              </div>
            </ng-template>

            <ng-template let-ctx nodeHtml>
              @let node = $any(ctx.data());

              <div
                class="node"
                [class.failing]="node.failing"
                [class.faded]="!isLit(flow, node.id, hovered)"
                [style.inline-size.px]="node.r * 2"
                [style.block-size.px]="node.r * 2"
                [attr.tabindex]="0"
                role="link"
                [attr.aria-label]="node.id + ', ' + node.spans + ' spans'"
                [matTooltip]="tooltip(node)"
                (click)="openTraces(node.id)"
                (keydown.enter)="openTraces(node.id)"
                (pointerenter)="highlight(node.id)"
                (pointerleave)="highlight(null)"
                (focus)="highlight(node.id)"
                (blur)="highlight(null)"
              >
                @if (node.entry) {
                  <!-- A span whose parent never arrived: the start of a trace,
                       or a hop nobody instrumented. Marked rather than hidden. -->
                  <span class="entry" aria-hidden="true"></span>
                }
                <span class="name">{{ node.id }}</span>

                <!-- Four of them, and the edges float: the library then meets
                     the circle on the side the other end actually is, which is
                     what stops three calls out of one service leaving as one
                     ribbon. -->
                <handle type="source" position="top" id="t" />
                <handle type="source" position="right" id="r" />
                <handle type="source" position="bottom" id="b" />
                <handle type="source" position="left" id="l" />
              </div>
            </ng-template>
          </vflow>

          <!-- The wheel and the drag are not discoverable, and neither is
               reachable from the keyboard. These are. -->
          <div class="controls fx-flex fx-gap-1">
            <button mat-icon-button type="button" aria-label="Zoom in" matTooltip="Zoom in" (click)="zoom(1.3)">
              <mat-icon>add</mat-icon>
            </button>
            <button mat-icon-button type="button" aria-label="Zoom out" matTooltip="Zoom out" (click)="zoom(1 / 1.3)">
              <mat-icon>remove</mat-icon>
            </button>
            <button
              mat-icon-button
              type="button"
              aria-label="Put the map back as it was laid out"
              matTooltip="Reset"
              (click)="reset()"
            >
              <mat-icon>fit_screen</mat-icon>
            </button>
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
      /* A frame, not a canvas that grows with the graph. The whole graph is
         scaled into this box and getting closer is what the zoom is for. */
      block-size: clamp(20rem, 60vh, 45rem);
      margin: 0 0 var(--fx-m);
      border: 1px solid var(--line);
      border-radius: var(--mat-sys-corner-medium);
      background: var(--surface);
      overflow: hidden;
    }

    vflow {
      display: block;
      inline-size: 100%;
      block-size: 100%;
    }

    .controls {
      position: absolute;
      inset-block-start: var(--fx-2xs);
      inset-inline-end: var(--fx-2xs);
      opacity: 0.55;
      transition: opacity 120ms ease;
      z-index: 1;
    }

    .map:hover .controls,
    .controls:focus-within {
      opacity: 1;
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

    .edge-label {
      color: var(--text-dim);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      /* The label sits on the edge it belongs to, so it needs the card behind
         it rather than the line under it. */
      background: var(--surface);
      padding: 0 var(--fx-3xs, 2px);
      border-radius: 3px;
    }

    .node {
      position: relative;
      box-sizing: border-box;
      border-radius: 50%;
      background: color-mix(in srgb, var(--accent) 22%, var(--surface));
      border: 1.5px solid var(--accent);
      /* Grab rather than pointer: a node is draggable as well as clickable,
         and the cursor is the only thing that says so. */
      cursor: grab;
    }

    .node:active {
      cursor: grabbing;
    }

    /* Two things the flow owns, which a scoped selector therefore cannot
       reach. Both come from the same mismatch: a service is drawn as a circle
       with its name underneath, and the library assumes a box.

       The box is a foreignObject, which clips to its own size by spec, so the
       name hanging below the circle was rendered and then cut off. And the
       handles are drawn as circles in the svg layer: nothing here connects
       nodes by hand, so they are measurement points for a floating edge, not
       controls, and a handle under the pointer would start a connection
       instead of a drag. */
    :host ::ng-deep .vflow-node foreignObject {
      overflow: visible;
    }

    :host ::ng-deep .default-handle {
      opacity: 0;
      pointer-events: none;
    }

    .node.failing {
      background: color-mix(in srgb, var(--error) 22%, var(--surface));
      border-color: var(--error);
    }

    .node:hover,
    .node:focus-visible {
      background: color-mix(in srgb, var(--accent) 38%, var(--surface));
    }

    .node:focus:not(:focus-visible) {
      outline: none;
    }

    .node .name {
      position: absolute;
      inset-block-start: calc(100% + 6px);
      inset-inline-start: 50%;
      translate: -50% 0;
      white-space: nowrap;
      color: var(--text);
      font-size: 12px;
      font-family: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace;
      pointer-events: none;
    }

    /* The marker leaves the circle up and to the left, clear of the side the
       edges arrive on. */
    .entry {
      position: absolute;
      inset-block-start: -14px;
      inset-inline-start: -14px;
      inline-size: 20px;
      block-size: 0;
      border-block-start: 1.5px dashed var(--text-dim);
      rotate: 45deg;
      pointer-events: none;
    }

    .node.faded,
    .edge-label.faded {
      opacity: 0.18;
    }

    .node,
    .edge,
    .edge-label {
      transition: opacity 140ms ease;
    }

    @media (prefers-reduced-motion: reduce) {
      .edge.lit {
        stroke-dasharray: none;
        animation: none;
      }

      .node,
      .edge,
      .edge-label,
      .controls {
        transition: none;
      }
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

  private readonly vflow = viewChild(VflowComponent);
  private readonly frame = viewChild<ElementRef<HTMLElement>>('frame');

  /** What each node is, by id, so a fit can measure what is actually drawn. */
  private readonly nodeData = new Map<string, NodeData>();

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

  /** The card behind the map is already the right colour; the flow paints its
   * own white over it otherwise. */
  protected readonly background: Background = { type: 'solid', color: 'transparent' };
  protected readonly minZoom = MIN_ZOOM;
  protected readonly maxZoom = MAX_ZOOM;

  /**
   * Nothing here connects nodes by hand, so handles exist only to give a
   * floating edge somewhere to land. In `strict` mode a floating edge looks
   * for a handle declared `type="target"` and finds none, which is an edge
   * with an empty path — drawn, invisible, and silent about why.
   */
  protected readonly connection: ConnectionSettings = { mode: 'loose' };

  /**
   * Node positions, kept across rebuilds of the flow.
   *
   * The library owns a node's position as a signal and writes to it when the
   * node is dragged, so handing it a fresh signal on every refresh would throw
   * the arrangement away. Reusing the signal per id means a node someone moved
   * stays where they put it when the data underneath changes.
   */
  private readonly points = new Map<string, ReturnType<typeof signal<{ x: number; y: number }>>>();
  /** Ids the user has actually dragged. Everything else follows the layout. */
  private readonly pinned = new Set<string>();

  /** Where dagre last put each node, so `reset` has somewhere to put them back
   * to without recomputing a layout. */
  private readonly laidOut = new Map<string, { x: number; y: number }>();

  /** Whether the graph has been fitted to the frame yet. See [`fitOnce`]. */
  private fitted = false;

  protected readonly flow$ = this.store.graph$.pipe(
    map((graph) => this.toFlow(graph)),
    tap((flow) => this.fitOnce(flow)),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /**
   * The node under the pointer, which is the one thing that makes a busy map
   * readable: everything it does not touch is pushed into the background for
   * as long as you are looking at it.
   */
  private readonly hovered$$ = new BehaviorSubject<string | null>(null);
  protected readonly hovered$ = this.hovered$$.asObservable();

  /** Set while a drag is in flight, so the click that ends it does not also
   * open a page. */
  private dragging = false;

  constructor() {
    // Switching app changes a path parameter, and Angular reuses the component
    // rather than recreating it — so nothing would re-run on its own. skip(1)
    // because the first emission is the scope this page just loaded under.
    this.scope.app$.pipe(skip(1), takeUntilDestroyed()).subscribe(() => {
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

  /**
   * Fit the graph into the frame, once, when there is first something to fit.
   *
   * Only the first time: after that the viewport is wherever the person
   * looking at it has put it, and a refresh that yanked the map back to centre
   * would undo their panning every few seconds. The timeout is for the nodes
   * this flow describes to have been rendered and measured — `fitView` reads
   * sizes from the DOM.
   */
  private fitOnce(flow: Flow): void {
    if (this.fitted || !flow.nodes.length) {
      return;
    }

    this.fitted = true;

    // Two things have to be true and neither is observable from here: the
    // `@if` above has to have put the flow in the DOM for the view query to
    // resolve, and the flow has to have measured its nodes, because `fitView`
    // reads their sizes and against unmeasured ones it silently does nothing.
    // So this waits a few frames for both, and gives up rather than spinning.
    let attempts = 30;

    const fit = (): void => {
      if (this.vflow()?.initialized()) {
        this.fitToFrame();

        return;
      }

      if (attempts-- > 0) {
        requestAnimationFrame(fit);
      }
    };

    requestAnimationFrame(fit);
  }

  /**
   * Scale and centre the whole map in its frame.
   *
   * Rather than the library's `fitView`, which measures the boxes it was given
   * — and a node's box here is its circle, while its name hangs below and well
   * past the sides of it. Fitting to the boxes cut the outermost labels off.
   * These bounds are of what is drawn: circle, label and all.
   */
  private fitToFrame(): void {
    const view = this.vflow();
    const frame = this.frame()?.nativeElement;

    if (!view || !frame || !this.nodeData.size) {
      return;
    }

    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;

    for (const [id, node] of this.nodeData) {
      const at = this.points.get(id)?.();

      if (!at) {
        continue;
      }

      // The label is centred under the circle and is the wider of the two on
      // anything but the busiest service. Monospace, so countable.
      const half = Math.max(node.r, (node.id.length * LABEL_ADVANCE) / 2);
      const cx = at.x + node.r;

      left = Math.min(left, cx - half);
      right = Math.max(right, cx + half);
      top = Math.min(top, at.y);
      bottom = Math.max(bottom, at.y + node.r * 2 + LABEL_SPACE);
    }

    const width = right - left;
    const height = bottom - top;

    if (!(width > 0) || !(height > 0)) {
      return;
    }

    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min(frame.clientWidth / width, frame.clientHeight / height) * 0.92),
    );

    view.viewportTo({
      zoom,
      x: (frame.clientWidth - width * zoom) / 2 - left * zoom,
      y: (frame.clientHeight - height * zoom) / 2 - top * zoom,
    });
  }

  protected selectGrouping(group: string): void {
    this.store.dispatch('selectGrouping', group);
    this.store.dispatch('load');
  }

  protected openTraces(service: string): void {
    // A drag that ends over a node still fires a click. Opening a page because
    // someone let go of the mouse in the wrong place is the kind of thing that
    // makes a map feel broken rather than draggable.
    if (this.dragging) {
      return;
    }

    this.router.navigate(this.scope.link('traces'), { queryParams: { service } });
  }

  protected onDrag(): void {
    this.dragging = true;
  }

  protected onDragEnd(): void {
    for (const [id, point] of this.points) {
      const home = this.laidOut.get(id);

      if (home && (point().x !== home.x || point().y !== home.y)) {
        this.pinned.add(id);
      }
    }

    // After the click this drag is about to produce, not before it.
    setTimeout(() => (this.dragging = false));
  }

  protected zoom(by: number): void {
    const flow = this.vflow();

    if (flow) {
      flow.zoomTo(flow.viewport().zoom * by);
    }
  }

  /** Back to the layout as it comes out of the data: every node the user moved
   * put back, and the whole graph fitted to the frame. */
  protected reset(): void {
    for (const [id, home] of this.laidOut) {
      this.points.get(id)?.set(home);
    }

    this.pinned.clear();
    this.fitToFrame();
  }

  protected highlight(id: string | null): void {
    if (this.dragging) {
      return;
    }

    this.hovered$$.next(id);
  }

  /** Whether a node keeps its colour: the hovered one, and whatever it talks
   * to. Everything else fades. */
  protected isLit(flow: Flow, id: string, hovered: string | null): boolean {
    return !hovered || id === hovered || (flow.neighbours.get(hovered)?.has(id) ?? false);
  }

  protected tooltip(node: NodeData): string {
    const errors = node.errors ? `, ${node.errors} in error` : '';

    return `${node.id}: ${node.spans.toLocaleString()} spans${errors}`;
  }

  /**
   * The service graph as something the flow library can draw.
   *
   * dagre does the layering — callers left of what they call, crossings
   * minimised, edges that skip a rank routed around whatever stands in the
   * middle. That last part is why it is here rather than a hand-rolled grid:
   * the routing is the hard half, and it is the half a layered layout exists
   * to do.
   *
   * The signals below are the library's own model, not application state; the
   * state is still the store and the observable above.
   */
  private toFlow(graph: ServiceGraph): Flow {
    const busiest = Math.max(...graph.nodes.map((node) => node.spans), 1);
    const entries = new Set(graph.entries.map((entry) => entry.target));
    const present = new Set(graph.nodes.map((node) => node.id));

    const data = this.nodeData;

    data.clear();

    for (const node of graph.nodes) {
      // Area, not radius, carries the count: a node with ten times the spans
      // should look ten times the node, and radius would make it a hundred.
      const r = 14 + 26 * Math.sqrt(node.spans / busiest);

      data.set(node.id, {
        id: node.id,
        spans: node.spans,
        errors: node.errors,
        r,
        failing: node.spans > 0 && node.errors / node.spans > ERROR_THRESHOLD,
        entry: entries.has(node.id),
      });
    }

    const dagre = new Graph();

    dagre.setGraph(DAGRE);
    dagre.setDefaultEdgeLabel(() => ({}));

    for (const node of data.values()) {
      // The box dagre spaces is the circle plus the room its label needs; the
      // circle is then centred in it. Without the label in the box, two long
      // service names in the same rank overlap under circles that do not.
      dagre.setNode(node.id, {
        width: Math.max(node.r * 2, node.id.length * LABEL_ADVANCE),
        height: node.r * 2 + LABEL_SPACE,
      });
    }

    for (const edge of graph.edges) {
      // A self-edge tells dagre nothing about ranking and upsets its router.
      if (edge.source !== edge.target && present.has(edge.source) && present.has(edge.target)) {
        dagre.setEdge(edge.source, edge.target);
      }
    }

    runDagre(dagre);

    const nodes = [...data.values()].map((node) => {
      const box = dagre.node(node.id);
      const home = {
        x: (box?.x ?? 0) - node.r,
        y: (box?.y ?? 0) - LABEL_SPACE / 2 - node.r,
      };

      this.laidOut.set(node.id, home);

      const point = this.points.get(node.id);

      if (!point) {
        this.points.set(node.id, signal(home));
      } else if (!this.pinned.has(node.id)) {
        point.set(home);
      }

      return {
        id: node.id,
        type: 'html-template' as const,
        point: this.points.get(node.id)!,
        width: signal(node.r * 2),
        height: signal(node.r * 2),
        data: signal(node),
      };
    });

    for (const id of [...this.points.keys()]) {
      if (!present.has(id)) {
        this.points.delete(id);
        this.pinned.delete(id);
        this.laidOut.delete(id);
      }
    }

    const busiestEdge = Math.max(...graph.edges.map((edge) => edge.calls), 1);
    const neighbours = new Map<string, Set<string>>();

    const edges = graph.edges
      .filter((edge) => present.has(edge.source) && present.has(edge.target))
      .map((edge) => {
        neighbours.set(edge.source, (neighbours.get(edge.source) ?? new Set()).add(edge.target));
        neighbours.set(edge.target, (neighbours.get(edge.target) ?? new Set()).add(edge.source));

        // Log, because call counts span orders of magnitude and a linear width
        // would draw every edge but the busiest as a hairline.
        const width = 1 + 5 * (Math.log1p(edge.calls) / Math.log1p(busiestEdge));

        return {
          id: `${edge.source}>${edge.target}`,
          source: edge.source,
          target: edge.target,
          type: 'template' as const,
          // Floating: the library picks the side of each circle that faces the
          // other end, instead of every edge leaving from one fixed handle.
          floating: signal(true),
          curve: signal('bezier' as const),
          markers: signal({ end: { type: 'arrow-closed' as const, color: 'currentColor' } }),
          edgeLabels: signal({
            center: { type: 'html-template' as const, data: { edge } },
          }),
          data: signal<EdgeData>({
            edge,
            width,
            failing: edge.calls > 0 && edge.errors / edge.calls > ERROR_THRESHOLD,
          }),
        };
      });

    return { nodes, edges, neighbours };
  }
}
