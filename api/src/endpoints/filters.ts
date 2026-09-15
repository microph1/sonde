import type { QueryParams } from '../clickhouse/clickhouse.service';

/** What every search accepts. Absent fields fall back to a bounded default so
 * no query can accidentally scan the whole retention window. */
export interface SearchFilters {
  readonly service?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
}

export const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
export const DEFAULT_LIMIT = 500;

/**
 * Turns user input into bound parameters.
 *
 * Optional filters are expressed as `{service:String} = '' OR …` in the SQL
 * rather than by concatenating clauses, so there is exactly one query text per
 * endpoint and nothing user-supplied ever reaches it.
 */
export function baseParams(filters: SearchFilters, maxLimit: number): QueryParams {
  const to = filters.to ?? new Date().toISOString();
  const from = filters.from ?? new Date(Date.parse(to) - DEFAULT_WINDOW_MS).toISOString();

  return {
    service: filters.service ?? '',
    from: assertTime(from, 'from'),
    to: assertTime(to, 'to'),
    limit: clampLimit(filters.limit, maxLimit),
  };
}

export function clampLimit(limit: number | undefined, maxLimit: number): number {
  if (limit === undefined) {
    return Math.min(DEFAULT_LIMIT, maxLimit);
  }

  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error('[400] limit must be a positive number');
  }

  return Math.min(Math.floor(limit), maxLimit);
}

/** ClickHouse would reject a bad timestamp anyway; rejecting it here turns a
 * 502 from the database into a 400 that names the offending field. */
export function assertTime(value: string, field: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`[400] ${field} is not a valid timestamp: ${value}`);
  }

  return value;
}

/** Shared by every signal: an optional service and a mandatory time window. */
export const WINDOW_SQL = `
  ({service:String} = '' OR ServiceName = {service:String})
  AND Timestamp >= parseDateTime64BestEffort({from:String}, 9)
  AND Timestamp <= parseDateTime64BestEffort({to:String}, 9)
`;
