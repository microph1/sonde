/**
 * Reads a newline-delimited JSON body as it arrives.
 *
 * The API pipes ClickHouse straight at us precisely so nothing has to wait for
 * the last row, so the client decodes incrementally rather than calling
 * `response.json()` — the first rows can render while the query is still
 * running.
 */
export async function* readNdjson<T>(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<T, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // A chunk boundary can land mid-row, so only whole lines are emitted and
      // the remainder stays buffered for the next read.
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);

        if (line.length > 0) {
          yield JSON.parse(line) as T;
        }

        newline = buffer.indexOf('\n');
      }
    }

    const last = buffer.trim();
    if (last.length > 0) {
      yield JSON.parse(last) as T;
    }
  } finally {
    reader.releaseLock();
  }
}
