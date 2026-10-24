import { ParamMap, Params } from '@angular/router';

/**
 * The window every page is of.
 *
 * Two shapes, because they answer different questions. A relative range —
 * "the last hour" — is what you want while something is happening, and it has
 * to resolve at the moment each request is built or the page would freeze at
 * whatever `now` meant when it loaded. An absolute range is what you want
 * afterwards, and until this existed the console could not express it at all:
 * every window ended at `now`, so an incident became unreachable the moment it
 * stopped being current.
 */
export type TimeRange = Relative | Absolute;

export interface Relative {
  readonly kind: 'relative';
  readonly label: string;
  readonly minutes: number;
  /** Chosen to keep each preset at roughly 50-70 points: dense enough to show
   * shape, sparse enough to stay readable at this width. */
  readonly bucketSeconds: number;
  readonly bucketLabel: string;
}

export interface Absolute {
  readonly kind: 'absolute';
  /** ISO 8601, both ends inclusive. */
  readonly from: string;
  readonly to: string;
}

export const RANGES: readonly Relative[] = [
  { kind: 'relative', label: '15m', minutes: 15, bucketSeconds: 30, bucketLabel: '30 seconds' },
  { kind: 'relative', label: '1h', minutes: 60, bucketSeconds: 60, bucketLabel: 'minute' },
  { kind: 'relative', label: '6h', minutes: 360, bucketSeconds: 300, bucketLabel: '5 minutes' },
  { kind: 'relative', label: '24h', minutes: 1440, bucketSeconds: 1800, bucketLabel: '30 minutes' },
  { kind: 'relative', label: '7d', minutes: 10080, bucketSeconds: 10800, bucketLabel: '3 hours' },
];

/** What a link that names no range gets. The URL is the only place a range is
 * remembered, so there is nothing else to fall back to. */
export const DEFAULT_RANGE: Relative = RANGES[3];

/** Roughly how many points a chart wants across its width. */
const BUCKETS = 60;

/**
 * The window as two instants.
 *
 * Resolved here rather than stored, so a relative range means the last hour
 * from the moment the request is built — not from the moment the page loaded.
 */
export function resolve(range: TimeRange): { from: string; to: string } {
  if (range.kind === 'absolute') {
    return { from: range.from, to: range.to };
  }

  const to = Date.now();

  return { from: new Date(to - range.minutes * 60_000).toISOString(), to: new Date(to).toISOString() };
}

export function spanMinutes(range: TimeRange): number {
  if (range.kind === 'relative') {
    return range.minutes;
  }

  return Math.max((Date.parse(range.to) - Date.parse(range.from)) / 60_000, 1);
}

/**
 * How wide a bucket should be for this window.
 *
 * A preset carries its own, picked by hand. An absolute range is any width at
 * all, so it gets one derived from the span — rounded up to something a person
 * would have chosen, because a 47-second bucket is an axis nobody can read.
 */
export function bucketOf(range: TimeRange): { seconds: number; label: string } {
  if (range.kind === 'relative') {
    return { seconds: range.bucketSeconds, label: range.bucketLabel };
  }

  const wanted = (spanMinutes(range) * 60) / BUCKETS;
  const seconds = NICE.find((candidate) => candidate >= wanted) ?? NICE[NICE.length - 1];

  return { seconds, label: labelFor(seconds) };
}

/** Bucket widths that divide a clock sensibly. */
const NICE = [1, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

function labelFor(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} seconds`;
  }

  const minutes = seconds / 60;

  if (minutes < 60) {
    return minutes === 1 ? 'minute' : `${minutes} minutes`;
  }

  const hours = minutes / 60;

  return hours === 1 ? 'hour' : `${hours} hours`;
}

/** What goes in the URL. A preset travels as its label; an absolute window as
 * its two ends, which is what makes it shareable at all. */
export function toParams(range: TimeRange): Params {
  return range.kind === 'relative'
    ? { range: range.label, from: null, to: null }
    : { range: null, from: range.from, to: range.to };
}

/**
 * The range a URL names, or nothing when it names none.
 *
 * `from`/`to` win over `range`: a link carrying both was built by something
 * that meant the absolute window, and silently preferring the preset would
 * send the reader to a different time than the one they were sent.
 */
export function fromParams(params: ParamMap): TimeRange | undefined {
  const from = params.get('from');
  const to = params.get('to');

  if (from && to && !Number.isNaN(Date.parse(from)) && !Number.isNaN(Date.parse(to))) {
    return { kind: 'absolute', from, to };
  }

  return RANGES.find((option) => option.label === params.get('range'));
}

export function sameRange(a: TimeRange | undefined, b: TimeRange | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) {
    return false;
  }

  return a.kind === 'relative'
    ? a.label === (b as Relative).label
    : a.from === (b as Absolute).from && a.to === (b as Absolute).to;
}

/** What the picker shows when the window is not one of the presets. */
export function describe(range: TimeRange): string {
  if (range.kind === 'relative') {
    return range.label;
  }

  const from = new Date(range.from);
  const to = new Date(range.to);
  const sameDay = from.toDateString() === to.toDateString();
  const time = (date: Date) =>
    date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const day = (date: Date) =>
    date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return sameDay
    ? `${day(from)} ${time(from)}–${time(to)}`
    : `${day(from)} ${time(from)} – ${day(to)} ${time(to)}`;
}
