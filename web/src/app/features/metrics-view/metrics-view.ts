import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { AsyncPipe } from '@angular/common';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatRippleModule } from '@angular/material/core';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { combineLatest, map, startWith } from 'rxjs';

import { Member, MetricOverview, MetricSummary, MetricsStore } from '../../core/metrics.store';
import { RANGES, Range } from '../../core/services.store';
import { PageHeader } from '../../shared/page-header';
import { Sparkline } from '../../shared/sparkline';
import { VolumeChart } from '../../shared/volume-chart';

interface Facet {
  readonly label: string;
  /** The metric this row came from, for anyone who needs to know exactly which
   * number they are reading. */
  readonly detail: string;
  readonly value: string;
}

interface MetricCard {
  readonly key: string;
  readonly title: string;
  /** The metric whose number leads and whose description the chart carries. */
  readonly lead: MetricOverview;
  /** Every metric on this card, lead first — each one a line on the chart. */
  readonly members: Member[];
  readonly facets: Facet[];
  readonly ceiling: string;
}

/**
 * Last segments that name a facet of a quantity rather than a quantity. Two
 * metrics sharing a prefix are only one thing if both of these are.
 */
const FACETS = new Set([
  'usage',
  'used',
  'peak',
  'limit',
  'max',
  'size',
  'total',
  'free',
  'available',
  'available_size',
  'physical_size',
  'used_size',
]);

/** Which facet leads: what is happening now, before what it has been, before
 * what it may become. A limit never leads - it is not a reading. */
const LEAD_ORDER = [
  'usage',
  'used',
  'size',
  'used_size',
  'physical_size',
  'total',
  'peak',
  'free',
  'available',
  'available_size',
  'max',
  'limit',
];

/** Everything before the facet: `container.memory.usage` scopes to
 * `container.memory`. */
function scope(name: string): string {
  const cut = name.lastIndexOf('.');

  return cut > 0 ? name.slice(0, cut) : name;
}

/**
 * The scope a name starts with: the part before the first separator.
 *
 * Both separators, because an older generation of these metrics is snake_case —
 * `relay_peer_connects_total` is the same `relay` as `relay.peer.connects`, and
 * grouping them apart would put a renamed metric in a section of its own until
 * the old one ages out.
 */
function firstSegment(name: string): string {
  const cut = name.search(/[._]/);

  return cut > 0 ? name.slice(0, cut) : name;
}

/**
 * The quantity a metric measures, independent of whose it is.
 *
 * The scope without its first segment: `container.memory.usage` and
 * `process.memory.usage` both reduce to `memory`, so the cgroup's number and
 * the process's own land on one card. `http.server.request.body.size` reduces
 * to `server.request.body`, which is deliberately *not* the same quantity as
 * `server.response.body` — dropping more than the leading segment would merge
 * a request with a response because both end in `body`.
 *
 * Unit and kind are in the key because two things measured differently are two
 * things. A name with nowhere to drop from keys on itself and groups with
 * nothing.
 */
function familyKey(metric: { name: string; unit: string; kind: string }): string {
  const segments = scope(metric.name).split('.');
  const quantity = segments.length > 1 ? segments.slice(1).join('.') : metric.name;

  return `${quantity}|${metric.unit}|${metric.kind}`;
}

function leaf(name: string): string {
  const cut = name.lastIndexOf('.');

  return cut > 0 ? name.slice(cut + 1) : name;
}

function order(name: string): number {
  const position = LEAD_ORDER.indexOf(leaf(name));

  return position === -1 ? LEAD_ORDER.length : position;
}

function share(value: number, of: number): string {
  const percent = Math.round((value / of) * 100);

  return percent < 1 ? '<1%' : `${percent}%`;
}

@Component({
  selector: 'wt-metrics-view',
  imports: [
    AsyncPipe,
    VolumeChart,
    Sparkline,
    MatButtonToggleModule,
    MatSlideToggleModule,
    MatRippleModule,
    MatTooltipModule, PageHeader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <wt-page-header
      heading="Metrics"
      subtitle="Every instrument reporting, with the shape of each. Pick one for the full breakdown."
    >

      @if (selected$ | async; as metric) {
        @if (metric.kind === 'sum') {
          <mat-slide-toggle
            [checked]="(rate$ | async) ?? false"
            (change)="toggleRate($event.checked)"
            matTooltip="Read the counter as a per-second rate rather than a running total"
          >
            per second
          </mat-slide-toggle>
        }
      }

      <mat-button-toggle-group
        aria-label="Time range"
        hideSingleSelectionIndicator
        [value]="rangeLabel$ | async"
      >
        @for (option of ranges; track option.label) {
          <mat-button-toggle [value]="option.label" (click)="selectRange(option)">
            {{ option.label }}
          </mat-button-toggle>
        }
      </mat-button-toggle-group>
    </wt-page-header>

    @if (selected$ | async; as metric) {
      <section class="detail fx-mb-6" [class.stale]="(loading$ | async) ?? false">
        <wt-volume-chart
          [points]="(points$ | async) ?? []"
          [empty]="absence(metric)"
          [reference]="(reference$ | async) ?? null"
          [format]="formatter(metric)"
          [title]="(selectedTitle$ | async) ?? metric.name"
          [unit]="unitLabel(metric)"
        />

        <p class="dim fx-mt-2">
          {{ metric.description || 'No description supplied by the instrument.' }}
          <span class="mono">
            · {{ metric.kind }}{{ metric.monotonic ? ', monotonic' : '' }}
            <!-- What is on the chart, which for a family is more than the
                 metric the description belongs to. -->
            @if ((drawn$ | async) ?? 0; as drawn) {
              @if (drawn > 1) {
                · {{ drawn }} metrics
              } @else {
                · {{ metric.series }} series
              }
            }
          </span>
        </p>
      </section>
    }

    <h2 class="sr-only">Everything reporting</h2>

    @for (group of groups$ | async; track group.name) {
      <h3 class="group fx-flex fx-items-baseline fx-gap-2">
        {{ group.name }}
        <span class="dim count">{{ group.cards.length }}</span>
      </h3>

      <section class="cards fx-mb-5">
        @for (card of group.cards; track card.key) {
        <button
          type="button"
          class="card"
          matRipple
          [class.current]="card.lead.name === (selectedName$ | async)"
          [attr.aria-pressed]="card.lead.name === (selectedName$ | async)"
          (click)="pick(card)"
        >
          <span class="top fx-flex fx-items-baseline fx-gap-2">
            <!-- The name is ellipsised to keep every card the same width, so
                 the full one has to stay reachable. -->
            <span class="name mono" [title]="card.title">{{ card.title }}</span>
            <span class="badge fx-ml-a">{{ reading(card.lead) }}</span>
          </span>

          <span class="value">
            {{ display(card.lead) }}<small class="suffix">{{ suffix(card.lead) }}</small>
            <!-- A ceiling belongs beside the reading it bounds, not on a card
                 of its own where 256 MB looks like a measurement. -->
            @if (card.ceiling) {
              <small class="ceiling">{{ card.ceiling }}</small>
            }
          </span>

          <wt-sparkline
            [points]="card.lead.points"
            [empty]="absence(card.lead)"
            [label]="card.title + ', ' + reading(card.lead) + ' over the selected window'"
          />

          @if (card.facets.length) {
            <span class="facets">
              @for (facet of card.facets; track facet.label) {
                <span class="facet">
                  <span class="dim" [title]="facet.detail">{{ facet.label }}</span>
                  <span class="num">{{ facet.value }}</span>
                </span>
              }
            </span>
          }

          <span class="foot dim">
            {{ card.lead.series }} {{ card.lead.series === 1 ? 'series' : 'series' }}
            @if (card.lead.unit) {
              · {{ card.lead.unit }}
            }
          </span>
        </button>
        }
      </section>
    } @empty {
      <p class="dim">Nothing has reported a metric yet.</p>
    }
  `,
  styles: `
    .control {
      display: flex;
      align-items: center;
      gap: var(--fx-3xs);
      color: var(--text-dim);
      font-size: var(--fx-typography--1);
    }

    .detail {
      max-width: 60rem;
      transition: opacity 0.15s ease;
    }

    .detail.stale {
      opacity: 0.55;
    }

    .group {
      margin: 0 0 var(--fx-2xs);
      font-size: var(--fx-typography-0);
      font-weight: 600;
      letter-spacing: 0.02em;
    }

    .group .count {
      font-size: var(--fx-typography--1);
      font-weight: 400;
    }

    /* Intrinsic: the column count is decided by how much room there is, not by
       a breakpoint someone picked. */
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
      gap: var(--fx-s);
    }

    .card {
      display: grid;
      transition: border-color 0.12s ease, background 0.12s ease;
      /* Both halves of the same fix: a grid item and a grid track size to auto
         by default, which means as wide as the longest unbreakable thing
         inside. A metric name is one long unbreakable thing, so without these
         the card grows past its column and its sparkline draws over the card
         next to it. */
      min-width: 0;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--fx-3xs);
      padding: var(--fx-2xs) var(--fx-s) var(--fx-s);
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--surface);
      text-align: left;
      cursor: pointer;
    }

    .card:hover,
    .card:focus-visible {
      border-color: var(--accent);
      background: var(--surface-raised);
    }

    .card.current {
      border-color: var(--accent);
      background: var(--surface-raised);
    }

    .top {
      min-width: 0;
    }

    .name {
      min-width: 0;
      font-size: var(--fx-typography--1);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .badge {
      padding: 0.05rem 0.4rem;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--text-dim);
      font-size: var(--fx-typography--2);
      white-space: nowrap;
    }

    /* Proportional figures: equal-width digits make a large standalone number
       look loose. The facet rows below keep tabular, because those do stack. */
    .value {
      font-size: var(--fx-typography-3);
      font-weight: 600;
      line-height: 1.1;
    }

    .facets {
      display: grid;
      grid-template-columns: max-content max-content;
      gap: 0 var(--fx-2xs);
      font-size: var(--fx-typography--2);
    }

    .facet {
      display: contents;
    }

    .facet .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    .ceiling {
      margin-inline-start: 0.35em;
      color: var(--text-dim);
      font-size: var(--fx-typography--1);
      font-weight: 400;
    }

    .suffix {
      margin-inline-start: 0.15em;
      color: var(--text-dim);
      font-size: var(--fx-typography--1);
      font-weight: 400;
    }

    .foot {
      font-size: var(--fx-typography--2);
    }
  `,
})
export class MetricsView implements OnInit {
  private readonly store = inject(MetricsStore);

  protected readonly ranges = RANGES;
  protected readonly overview$ = this.store.overview$;

  /**
   * Metrics that describe one quantity, on one card.
   *
   * container.memory.usage, .peak and .limit are three names for one sentence -
   * "using 12.9 MB, peaked at 13.8, out of 256" - and as three alphabetically
   * sorted cards they read as three unrelated facts, with the 256 MB ceiling
   * leading and looking like a measurement.
   *
   * They stay three metrics, though. Collapsing them into one with a
   * state=current|peak|limit attribute is the standard-looking answer and it is
   * wrong: usage and peak are measurements, limit is a property, and putting
   * the constant back in the series is exactly what makes a chart unreadable.
   * This is a grouping in the view, which is where the problem was.
   */
  protected readonly cards$ = this.store.overview$.pipe(map((metrics) => this.group(metrics)));

  /**
   * Cards under the scope their names already carry.
   *
   * Thirty-odd cards in one alphabetical grid is a list you search rather than
   * read. The prefixes were chosen deliberately by whoever instrumented the
   * service - container, process, host, relay - so the page can group on them
   * instead of inventing a taxonomy.
   */
  protected readonly groups$ = this.cards$.pipe(
    map((cards) => {
      const groups = new Map<string, MetricCard[]>();

      for (const card of cards) {
        const name = firstSegment(card.title);

        groups.set(name, [...(groups.get(name) ?? []), card]);
      }

      return [...groups.entries()]
        .map(([name, members]) => ({ name, cards: members }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }),
  );

  /** The card's name, not one of its lines': a chart of three memory readings
   * is titled container.memory, not container.memory.usage. */
  protected readonly selectedTitle$ = combineLatest([this.cards$, this.store.selected$]).pipe(
    map(([cards, selected]) =>
      selected
        ? (cards.find((card) => card.lead.name === selected.name)?.title ?? selected.name)
        : '',
    ),
  );

  /** Held rather than blanked while the next window loads: a chart that
   * disappears and comes back jumps the page and loses the shape you were
   * comparing against. */
  protected readonly loading$ = this.store.getLoadingFor('loadSeries').pipe(startWith(false));

  /** How many metrics the chart is drawing, which is not the same as how many
   * attribute series the lead one has. */
  protected readonly drawn$ = this.store.members$.pipe(map((members) => members.length));
  protected readonly selected$ = this.store.selected$;
  protected readonly points$ = this.store.points$;
  protected readonly rate$ = this.store.rate$;
  protected readonly reference$ = this.store.reference$;
  protected readonly rangeLabel$ = this.store.range$.pipe(map((range) => range.label));
  protected readonly selectedName$ = this.store.selected$.pipe(map((metric) => metric?.name ?? ''));

  ngOnInit(): void {
    this.store.dispatch('loadCatalogue');
  }

  /**
   * A family is a set of metrics sharing a dotted prefix whose last segments
   * are all facets of the same quantity. The allow-list is what keeps this from
   * grouping things that merely share a prefix: relay.peer.connects and
   * relay.peer.disconnects are two quantities, not two views of one.
   */
  private group(metrics: MetricOverview[]): MetricCard[] {
    const families = new Map<string, MetricOverview[]>();

    // Keyed by the quantity rather than by the name's prefix, so the cgroup's
    // memory and the process's own land on one card. Splitting them by scope is
    // correct and pedantic: it makes you look in two places to answer one
    // question. Unit and kind are in the key because two things measured
    // differently are two things.
    for (const metric of metrics) {
      const family = familyKey(metric);

      families.set(family, [...(families.get(family) ?? []), metric]);
    }

    const cards: MetricCard[] = [];

    for (const members of families.values()) {
      const facets = members.every((metric) => FACETS.has(leaf(metric.name)));

      if (members.length < 2 || !facets) {
        cards.push(...members.map((metric) => this.plain(metric)));
        continue;
      }

      cards.push(this.family(members));
    }

    return cards.sort((a, b) => a.title.localeCompare(b.title));
  }

  private plain(metric: MetricOverview): MetricCard {
    return {
      key: `${metric.name}|${metric.kind}`,
      title: metric.name,
      lead: metric,
      members: [{ key: `${metric.name}|${metric.kind}`, label: metric.name }],
      facets: [],
      ceiling: this.ceiling(metric, scope(metric.name)),
    };
  }

  /**
   * "12.9 MB of 256.0 MB (5%)", when the resource says what the ceiling is.
   *
   * The cap comes from a resource attribute rather than a sibling metric: a
   * limit is a property of the container, not a measurement of it. Nothing to
   * show when the container is uncapped, which is the honest answer — the
   * cgroup reads `max` and a fabricated ceiling would be worse than none.
   */
  private ceiling(metric: MetricOverview, family: string): string {
    const limit = Number(metric.limits?.[`${family}.limit`]);

    if (!Number.isFinite(limit) || limit <= 0 || metric.latest === null) {
      return '';
    }

    return `of ${this.formatter(metric)(limit)} (${share(metric.latest, limit)})`;
  }

  private family(members: MetricOverview[]): MetricCard {
    const ranked = [...members].sort((a, b) => order(a.name) - order(b.name));
    const lead = ranked[0];

    // Named for the scope whose ceiling the numbers are read against. On a
    // container that is the cgroup's, which is also what the OOM killer acts
    // on, so it is the one the others are compared to.
    const title = scope(
      members.find((metric) => metric.limits?.[`${scope(metric.name)}.limit`])?.name ?? lead.name,
    );

    const ceiling = this.ceiling(lead, title);

    const label = (metric: MetricOverview) =>
      scope(metric.name) === title
        ? leaf(metric.name)
        : `${firstSegment(scope(metric.name))} ${leaf(metric.name)}`;

    return {
      key: title,
      title,
      lead,
      ceiling,
      // Lead first: the chart draws them in this order, and colour follows the
      // entity, so usage keeps its hue whatever else is on the card.
      members: ranked.map((metric) => ({
        key: `${metric.name}|${metric.kind}`,
        label: label(metric),
      })),
      facets: ranked.map((metric) => ({
        // A member from another scope keeps it in the label: `process usage` is
        // the relay's own resident pages, `usage` is the cgroup's, which
        // includes page cache. Same card, different numbers, and the difference
        // matters when one of them is climbing.
        label: label(metric),
        detail: metric.description ? `${metric.name} — ${metric.description}` : metric.name,
        value: metric.latest === null ? '—' : this.formatter(metric)(metric.latest),
      })),
    };
  }

  protected pick(card: MetricCard): void {
    this.store.dispatch('selectMetric', card.members);
  }

  protected selectRange(range: Range): void {
    this.store.dispatch('selectRange', range);
  }

  protected toggleRate(rate: boolean): void {
    this.store.dispatch('toggleRate', rate);
  }

  /**
   * What the card's figure and line actually mean.
   *
   * A cumulative counter and a histogram's count are only legible as a rate; a
   * gauge is a reading; an up-down counter is a level. Saying which one is on
   * the card is the difference between a number and a number you can trust.
   */
  protected reading(metric: MetricSummary): string {
    if (metric.kind === 'histogram' || (metric.kind === 'sum' && metric.monotonic)) {
      return 'rate';
    }

    return metric.kind === 'sum' ? 'level' : 'gauge';
  }

  /**
   * Why there is no line.
   *
   * A rate is the difference between two buckets, so a counter deployed inside
   * the window has reported and still has nothing to draw. "No data in this
   * window" reads as something being broken; it is the opposite - the data is
   * too new, and the next bucket fixes it.
   */
  protected absence(metric: MetricOverview): string {
    return metric.samples > 0
      ? 'not enough history yet for a rate'
      : 'no data in this window';
  }

  protected display(metric: MetricOverview): string {
    if (metric.latest === null) {
      return '—';
    }

    return this.formatter(metric)(metric.latest);
  }

  protected suffix(metric: MetricOverview): string {
    if (metric.latest === null) {
      return '';
    }

    return this.reading(metric) === 'rate' ? '/s' : '';
  }

  /**
   * Bytes read as bytes, seconds as time, everything else as a plain number.
   *
   * A histogram is the exception: its card reads observations per second, and
   * a count of observations is not measured in the unit of the thing observed.
   * Formatting the rate of `http.server.request.duration` in milliseconds gave
   * a card reading "microseconds per second", which is not a quantity.
   */
  protected formatter(metric: MetricSummary): (value: number) => string {
    if (metric.kind === 'histogram') {
      return count;
    }

    if (metric.unit === 'By') {
      return bytes;
    }

    if (metric.unit === 's' || metric.unit === 'ms') {
      return metric.unit === 's' ? seconds : (value: number) => seconds(value / 1000);
    }

    return count;
  }

  protected unitLabel(metric: MetricSummary): string {
    return metric.kind === 'sum' ? 'per second' : metric.unit || 'value';
  }
}

function bytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} kB`;

  return `${value.toFixed(0)} B`;
}

function seconds(value: number): string {
  if (value >= 1) return `${value.toFixed(2)} s`;
  if (value >= 0.001) return `${(value * 1000).toFixed(0)} ms`;

  return `${(value * 1_000_000).toFixed(0)} µs`;
}

/** Enough significance to tell 0.02 from 0, without six decimals of noise on a
 * number that happens to be large. */
function count(value: number): string {
  if (value === 0) return '0';
  if (Math.abs(value) >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (Math.abs(value) >= 10) return value.toFixed(1);

  return value.toFixed(2);
}
