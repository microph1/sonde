import type { Request } from 'express';

/**
 * Reads a cookie off the raw header.
 *
 * Express writes cookies natively through `res.cookie()` but only parses them
 * with `cookie-parser` middleware; for the one cookie this API reads, a
 * dependency is more surface than the four lines it would save.
 */
export function readCookie(req: Request, name: string): string | undefined {
  for (const pair of (req.headers.cookie ?? '').split(';')) {
    const separator = pair.indexOf('=');

    if (separator > 0 && pair.slice(0, separator).trim() === name) {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    }
  }

  return undefined;
}
