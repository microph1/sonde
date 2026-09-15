import { ExpressEventHandler } from '@microgamma/apigator';
import { Injectable } from '@microphi/di';
import { getDebugger } from '@microphi/debug';
import { pipeline } from 'node:stream/promises';
import type { Response } from 'express';

import { isStreamingResult } from '../clickhouse/streaming-result';

const d = getDebugger('watchers:api:handler');

/**
 * Adds streaming to apigator's Express handler.
 *
 * The default calls `res.json(retValue)`, which requires the whole result in
 * memory. An endpoint that returns a `StreamingResult` instead gets its body
 * piped straight through, so a million-row query costs the same memory as a
 * one-row query. Everything else keeps the original behaviour.
 */
@Injectable()
export class StreamingEventHandler extends ExpressEventHandler {
  public override async runOriginalFunction(
    originalFunction: (...args: unknown[]) => unknown,
    instance: unknown,
    newArgs: unknown[],
    [, res]: [unknown, Response],
  ): Promise<unknown> {
    try {
      const retValue = await originalFunction.apply(instance, newArgs);

      if (!isStreamingResult(retValue)) {
        return res.json(retValue);
      }

      res.setHeader('Content-Type', retValue.contentType);
      // Flush headers before the first row so a slow query still shows the
      // client that the request was accepted.
      res.flushHeaders();

      await pipeline(retValue.body, res);
      d('stream complete');
      return undefined;
    } catch (e) {
      return this.fail(res, e);
    }
  }

  /**
   * apigator's convention is a `[404] message` prefix on the error; anything
   * unprefixed is ours and therefore a 500.
   *
   * Once the body has started there is no status left to send, so the only
   * honest thing is to destroy the connection — a truncated NDJSON stream is
   * detectable by the client, a silently short one is not.
   */
  private fail(res: Response, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);

    if (res.headersSent) {
      d('failing mid-stream', message);
      res.destroy(error instanceof Error ? error : new Error(message));
      return;
    }

    const match = message.match(/^\[(\d{3,})\]\s*(.*)$/s);

    if (match) {
      res.status(Number(match[1])).json({ error: match[2] });
    } else {
      res.status(500).json({ error: message });
    }
  }
}
