import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { AsyncPipe, DecimalPipe } from '@angular/common';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { GraphEdge, GraphStore, ServiceGraph } from '../../core/graph.store';
import { RANGES, Range } from '../../core/services.store';
import { PageHeader } from '../../shared/page-header';

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
  readonly width: number;
  readonly height: number;
}

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
    RouterLink,
    PageHeader,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatSelectModule,
    MatTooltipModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <wt-page-header
      heading="Map"
      subtitle="Who calls whom, read from the spans themselves — an edge is a parent and a child that landed in different services."
    >
      <mat-form-field subscriptSizing="dynamic" class="grouping">
        <mat-label>Group by</mat-label>
        <mat-select [value]="group$ | async" (selectionChange)="selectGrouping($event.value)">
          @for (option of groupings; track option.key) {
            <mat-option [value]="option.key">{{ option.label }}</mat-option>
          }
        </mat-select>
      </mat-form-field>

      <mat-button-toggle-group aria-label="Time range" hideSingleSelectionIndicator [value]="(range$ | async)?.label">
        @for (option of ranges; track option.label) {
          <mat-button-toggle [value]="option.label" (click)="selectRange(option)">
            {{ option.label }}
          </mat-button-toggle>
        }
      </mat-button-toggle-group>
    </wt-page-header>

    @if (layout$ | async; as layout) {
      @if (layout.nodes.length) {
        <figure class="map">
          <svg [attr.viewBox]="'0 0 ' + layout.width + ' ' + layout.height" role="img"
               [attr.aria-label]="describe(layout)">
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
          </svg>
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
                <td class="num">{{ edge.p95Ms | number: '1.0-1' }} ms</td>
                <td class="dim">{{ edge.kinds }}</td>
                <td>
                  <a [routerLink]="['/traces']" [queryParams]="{ service: edge.target }">traces</a>
                </td>
              </tr>
            }
            @for (entry of (graph$ | async)?.entries ?? []; track entry.target) {
              <tr>
                <th scope="row" class="dim">entry point</th>
                <td class="mono">{{ entry.target }}</td>
                <td class="num">{{ entry.calls | number }}</td>
                <td class="num" [class.bad]="entry.errors > 0">{{ entry.errors | number }}</td>
                <td class="num">{{ entry.p95Ms | number: '1.0-1' }} ms</td>
                <td class="dim">{{ entry.kinds }}</td>
                <td>
                  <a [routerLink]="['/traces']" [queryParams]="{ service: entry.target }">traces</a>
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
      margin: 0 0 var(--fx-m);
      padding: var(--fx-s);
      border: 1px solid var(--line);
      border-radius: var(--mat-sys-corner-medium);
      background: var(--surface);
      overflow-x: auto;
    }

    svg {
      width: 100%;
      height: auto;
      overflow: visible;
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
      font-family: ui-monospace, 'JetBrains Mono', 'SF Mono', Menlo, monospace;
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
  private readonly router = inject(Router);

  protected readonly ranges = RANGES;
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

  ngOnInit(): void {
    this.store.dispatch('load');
  }

  protected selectRange(range: Range): void {
    this.store.dispatch('selectRange', range);
    this.store.dispatch('load');
  }

  protected selectGrouping(group: string): void {
    this.store.dispatch('selectGrouping', group);
    this.store.dispatch('load');
  }

  protected openTraces(service: string): void {
    this.router.navigate(['/traces'], { queryParams: { service } });
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

  return {
    nodes: [...placed.values()],
    edges,
    width: MARGIN.x * 2 + Math.max(columns.size - 1, 0) * COLUMN,
    height: MARGIN.y * 2 + Math.max(tallest - 1, 0) * ROW,
  };
}
