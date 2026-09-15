import { ClickHouseService, QueryParams } from './clickhouse.service';
import { SseEvent } from './sse-result';

export interface TailOptions<T> {
  readonly clickhouse: ClickHouseService;
  /** Must select a `Timestamp` column and accept `{since:String}`. */
  readonly sql: string;
  readonly params: QueryParams;
  /** Identity used to suppress rows already delivered. */
  readonly key: (row: T) => string;
  readonly since: string;
  readonly pollMs?: number;
  /** Abort signal fired when the client disconnects. */
  readonly signal: AbortSignal;
}

export const DEFAULT_POLL_MS = 1000;

/**
 * Rows that arrive after `since`, polled until the client goes away.
 *
 * ClickHouse cannot push, so this is a watermark poll — but the watermark is
 * held back by `OVERLAP_MS` and the rows it re-reads are de-duplicated by key.
 * Without that, anything whose event timestamp is older than the newest row
 * already seen would be missed, and with a broker in the ingest path that is
 * routine rather than rare.
 */
const OVERLAP_MS = 10_000;

export async function* tail<T extends { Timestamp: string }>(
  options: TailOptions<T>,
): AsyncGenerator<SseEvent> {
  const { clickhouse, sql, params, key, signal } = options;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  let watermark = options.since;
  let delivered = new Set<string>();

  while (!signal.aborted) {
    const since = new Date(Date.parse(watermark) - OVERLAP_MS).toISOString();
    const rows = await clickhouse.rows<T>(sql, { ...params, since });

    const fresh: T[] = [];
    for (const row of rows) {
      const identity = key(row);

      if (!delivered.has(identity)) {
        delivered.add(identity);
        fresh.push(row);
      }
    }

    for (const row of fresh) {
      yield { event: 'row', data: row, id: row.Timestamp };

      if (row.Timestamp > watermark) {
        watermark = row.Timestamp;
      }
    }

    // Keys only need to live as long as the overlap window can re-read them.
    if (delivered.size > 10_000) {
      delivered = new Set(fresh.map(key));
    }

    if (fresh.length === 0) {
      // Keeps proxies from closing an idle connection, and lets the client see
      // that the tail is alive rather than merely quiet.
      yield { event: 'heartbeat', data: { at: new Date().toISOString() } };
    }

    await sleep(pollMs, signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
