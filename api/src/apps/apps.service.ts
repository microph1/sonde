import { Injectable, Inject } from '@microphi/di';
import { getDebugger } from '@microphi/debug';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { APPS_TABLE, KEYS_TABLE, statements } from './schema';

const d = getDebugger('sonde:api:apps');

export interface App {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export type KeyKind = 'secret' | 'public';

export interface ApiKey {
  readonly id: string;
  readonly appId: string;
  readonly kind: KeyKind;
  readonly name: string;
  readonly hint: string;
  readonly origins: string[];
  readonly createdAt: string;
  readonly revoked: number;
}

/** Only ever returned once, at creation. */
export interface IssuedKey extends ApiKey {
  readonly secret: string;
}

/** `wk_` for secret, `wpk_` for public — so a key found in a log or a bundle
 * announces which kind of mistake it is. */
const PREFIXES: Record<KeyKind, string> = { secret: 'wk_', public: 'wpk_' };

@Injectable()
export class AppsService {
  constructor(@Inject(ClickHouseService) private clickhouse: ClickHouseService) {}

  async ensureSchema(): Promise<void> {
    for (const statement of statements()) {
      await this.clickhouse.execute(statement);
    }

    d('apps schema ready');
  }

  async listApps(): Promise<App[]> {
    return this.clickhouse.rows<App>(
      `SELECT id, name, toString(createdAt) AS createdAt
       FROM ${APPS_TABLE} FINAL
       WHERE deleted = 0
       ORDER BY createdAt`,
    );
  }

  async createApp(name: string): Promise<App> {
    const trimmed = name.trim();

    if (!trimmed) {
      throw new Error('[400] an app needs a name');
    }

    const app: App = { id: randomUUID(), name: trimmed, createdAt: new Date().toISOString() };

    await this.clickhouse.execute(
      `INSERT INTO ${APPS_TABLE} (id, name, createdAt, updatedAt, deleted)
       VALUES ({id:String}, {name:String}, now64(3), now64(3), 0)`,
      { id: app.id, name: app.name },
    );

    return app;
  }

  async deleteApp(appId: string): Promise<void> {
    // A tombstone row rather than a DELETE: ReplacingMergeTree resolves it on
    // read, and the telemetry already ingested under this app stays queryable.
    await this.clickhouse.execute(
      `INSERT INTO ${APPS_TABLE} (id, name, createdAt, updatedAt, deleted)
       SELECT id, name, createdAt, now64(3), 1 FROM ${APPS_TABLE} FINAL WHERE id = {id:String}`,
      { id: appId },
    );
  }

  async listKeys(appId?: string): Promise<ApiKey[]> {
    return this.clickhouse.rows<ApiKey>(
      `SELECT id, appId, kind, name, hint, origins,
              toString(createdAt) AS createdAt, revoked
       FROM ${KEYS_TABLE} FINAL
       WHERE ({appId:String} = '' OR appId = {appId:String})
       ORDER BY createdAt DESC`,
      { appId: appId ?? '' },
    );
  }

  /**
   * Issues a key. The secret is returned here and never again — only its hash
   * is stored, so there is nowhere to look it up from later.
   */
  async createKey(input: {
    appId: string;
    kind: KeyKind;
    name: string;
    origins?: string[];
  }): Promise<IssuedKey> {
    const apps = await this.listApps();

    if (!apps.some((app) => app.id === input.appId)) {
      throw new Error('[404] no such app');
    }

    if (input.kind !== 'secret' && input.kind !== 'public') {
      throw new Error('[400] kind must be `secret` or `public`');
    }

    const secret = `${PREFIXES[input.kind]}${randomBytes(24).toString('base64url')}`;
    const key: ApiKey = {
      id: randomUUID(),
      appId: input.appId,
      kind: input.kind,
      name: input.name.trim() || 'unnamed',
      hint: `${secret.slice(0, PREFIXES[input.kind].length + 6)}…`,
      origins: input.origins ?? [],
      createdAt: new Date().toISOString(),
      revoked: 0,
    };

    await this.clickhouse.execute(
      `INSERT INTO ${KEYS_TABLE}
         (id, appId, kind, name, secretHash, hint, origins, createdAt, updatedAt, revoked)
       VALUES
         ({id:String}, {appId:String}, {kind:String}, {name:String}, {secretHash:String},
          {hint:String}, {origins:Array(String)}, now64(3), now64(3), 0)`,
      {
        id: key.id,
        appId: key.appId,
        kind: key.kind,
        name: key.name,
        // A public key is not a secret, so it is stored as-is: the receiver has
        // to be able to match it against an Origin, and hashing would buy
        // nothing it does not already give away.
        secretHash: input.kind === 'secret' ? hash(secret) : secret,
        hint: key.hint,
        origins: clickHouseArray(key.origins),
      },
    );

    d('issued %s key for app %s', key.kind, key.appId);

    return { ...key, secret };
  }

  async revokeKey(keyId: string): Promise<void> {
    await this.clickhouse.execute(
      `INSERT INTO ${KEYS_TABLE}
         (id, appId, kind, name, secretHash, hint, origins, createdAt, updatedAt, revoked)
       SELECT id, appId, kind, name, secretHash, hint, origins, createdAt, now64(3), 1
       FROM ${KEYS_TABLE} FINAL WHERE id = {id:String}`,
      { id: keyId },
    );
  }
}

export function hash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * ClickHouse binds `Array(String)` parameters from its own literal syntax —
 * single-quoted elements — not from JSON, which uses double quotes and is
 * rejected outright.
 */
function clickHouseArray(values: string[]): string {
  const quoted = values.map((value) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);

  return `[${quoted.join(',')}]`;
}
