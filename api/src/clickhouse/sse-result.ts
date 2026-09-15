/** One server-sent event. `id` becomes `Last-Event-ID` on reconnect. */
export interface SseEvent {
  readonly event: string;
  readonly data: unknown;
  readonly id?: string;
}

export type SseSource = (signal: AbortSignal) => AsyncIterable<SseEvent>;

/**
 * An open-ended event stream.
 *
 * Distinct from `StreamingResult`, which is a finite query result piped at the
 * client: this one never completes on its own and ends when the client
 * disconnects. It carries a factory rather than an iterable so the handler —
 * the only thing that knows when the socket closes — owns the abort signal that
 * stops the work.
 */
export class SseResult {
  constructor(
    public readonly source: SseSource,
    /** How long the browser should wait before reconnecting, in ms. */
    public readonly retryMs = 3000,
  ) {}
}

export function isSseResult(value: unknown): value is SseResult {
  return value instanceof SseResult;
}
