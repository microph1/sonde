import { Injectable } from '@microphi/di';
import { getDebugger } from '@microphi/debug';

import { configFromEnv } from '../config';
import { StreamingResult } from './streaming-result';

const d = getDebugger('sonde:api:clickhouse');

/** Values a query placeholder can carry. Everything reaches ClickHouse as a
 * bound parameter, never as interpolated SQL. */
export type QueryParams = Record<string, string | number>;

@Injectable()
export class ClickHouseService {
  private readonly config = configFromEnv().clickhouse;

  /**
   * Runs a query and hands back the still-unread response body.
   *
   * `JSONEachRow` is deliberate: it is newline-delimited, so the client can
   * render rows as they arrive and nothing here needs to know how many there
   * are or hold them all at once.
   */
  async stream(sql: string, params: QueryParams = {}): Promise<StreamingResult> {
    const response = await this.request(`${sql} FORMAT JSONEachRow`, params);

    if (!response.body) {
      throw new Error('[502] clickhouse returned no body');
    }

    return StreamingResult.fromWeb(response.body);
  }

  /**
   * For results that are small and bounded by construction — a service list, a
   * count — where the caller wants objects rather than a pipe.
   */
  async rows<T>(sql: string, params: QueryParams = {}): Promise<T[]> {
    const response = await this.request(`${sql} FORMAT JSONEachRow`, params);
    const text = await response.text();

    return text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as T);
  }

  /** For statements with nothing to read back: DDL, and the inserts that stand
   * in for updates on the configuration tables. */
  async execute(sql: string, params: QueryParams = {}): Promise<void> {
    await this.request(sql, params);
  }

  private async request(sql: string, params: QueryParams): Promise<Response> {
    const url = new URL(this.config.url);
    url.searchParams.set('database', this.config.database);

    // ClickHouse binds `{name:Type}` placeholders from `param_name`, which is
    // what keeps user input out of the SQL text entirely.
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(`param_${name}`, String(value));
    }

    d('query', { sql, params });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-ClickHouse-User': this.config.user,
        'X-ClickHouse-Key': this.config.password,
        'Content-Type': 'text/plain',
      },
      body: sql,
    });

    if (!response.ok) {
      const detail = await response.text();
      // ClickHouse reports a malformed query as 400; surfacing its own message
      // is far more useful than a generic failure, and it never contains the
      // credentials since those travel in headers.
      throw new Error(`[${response.status === 400 ? 400 : 502}] clickhouse: ${detail.trim()}`);
    }

    return response;
  }
}
