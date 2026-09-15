import { ExpressEventHandler } from '@microgamma/apigator';
import { Injectable } from '@microphi/di';
import { getDebugger } from '@microphi/debug';
import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';

import { SseResult, isSseResult } from '../clickhouse/sse-result';
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
    [req, res]: [Request, Response],
  ): Promise<unknown> {
    try {
      const retValue = await originalFunction.apply(instance, newArgs);

      if (isSseResult(retValue)) {
        return await this.sse(req, res, retValue);
      }

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
   * Writes an open-ended `text/event-stream`.
   *
   * `no-transform` matters as much as `no-cache`: a proxy that buffers to
   * "optimise" the response would defeat the point, and events would arrive in
   * clumps or not at all.
   */
  private async sse(req: Request, res: Response, result: SseResult): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`retry: ${result.retryMs}\n\n`);

    const aborter = new AbortController();
    // Whatever is producing events keeps running until told otherwise, so a
    // closed socket has to reach it: without this the poll outlives the client.
    res.on('close', () => aborter.abort());

    try {
      for await (const event of result.source(aborter.signal)) {
        if (res.writableEnded) {
          break;
        }

        if (event.id !== undefined) {
          res.write(`id: ${event.id}\n`);
        }

        res.write(`event: ${event.event}\n`);
        res.write(`data: ${JSON.stringify(event.data)}\n\n`);
      }
    } finally {
      aborter.abort();
      d('sse closed', req.path);
      res.end();
    }
  }

  /**
   * apigator has `@Path`, `@Body` and `@Header` but no `@Query`, and an
   * `EventSource` can only issue a GET with no body — so a tail's filters have
   * nowhere else to travel. Merging the query string in lets those endpoints
   * read them with `@Path`; route params still win on a collision.
   */
  public override getPathParams([req]: [Request]): Record<string, unknown> {
    return { ...req.query, ...req.params };
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
