import { Readable } from 'node:stream';

/**
 * A response body that has not been read into memory.
 *
 * Returning one of these from an endpoint tells the handler to pipe it at the
 * client instead of serialising it: the rows go ClickHouse socket → our socket
 * without ever becoming JavaScript objects, which is the whole reason the read
 * path can stay on Node while returning large result sets.
 */
export class StreamingResult {
  constructor(
    public readonly body: Readable,
    public readonly contentType = 'application/x-ndjson',
  ) {}

  static fromWeb(body: ReadableStream<Uint8Array>, contentType?: string): StreamingResult {
    return new StreamingResult(Readable.fromWeb(body as never), contentType);
  }
}

export function isStreamingResult(value: unknown): value is StreamingResult {
  return value instanceof StreamingResult;
}
