import { Injectable } from '@microphi/di';
import { SignJWT, jwtVerify } from 'jose';
import type { Request, Response } from 'express';

import { configFromEnv } from '../config';
import { readCookie } from './cookies';

export interface SessionUser {
  readonly sub: string;
  readonly email: string;
  readonly name: string;
}

export const SESSION_COOKIE = 'sonde_session';

/**
 * Sessions are a signed JWT in an httpOnly cookie rather than server-side
 * state: the API is horizontally scalable and holds nothing else per-user, so
 * a session store would be the only thing forcing sticky routing or a shared
 * cache.
 *
 * The trade-off is that a session cannot be revoked before it expires, which is
 * why the lifetime is hours rather than weeks.
 */
@Injectable()
export class Sessions {
  private readonly config = configFromEnv().auth;
  private readonly secret = new TextEncoder().encode(configFromEnv().auth.sessionSecret);

  async issue(user: SessionUser, res: Response): Promise<void> {
    const token = await new SignJWT({ email: user.email, name: user.name })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.sub)
      .setIssuedAt()
      .setExpirationTime(`${this.config.sessionHours}h`)
      .sign(this.secret);

    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      // Lax rather than Strict: the IdP redirects back to us cross-site, and
      // Strict would withhold the cookie on that first navigation.
      sameSite: 'lax',
      secure: this.config.secureCookies,
      path: '/',
      maxAge: this.config.sessionHours * 3600 * 1000,
    });
  }

  clear(res: Response): void {
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.secureCookies,
      path: '/',
    });
  }

  /** The current user, or null when there is no valid session. */
  async read(req: Request): Promise<SessionUser | null> {
    const token = readCookie(req, SESSION_COOKIE);

    if (!token) {
      return null;
    }

    try {
      const { payload } = await jwtVerify(token, this.secret);

      return {
        sub: String(payload.sub),
        email: String(payload['email'] ?? ''),
        name: String(payload['name'] ?? ''),
      };
    } catch {
      // Expired or tampered with; either way there is no session. Not logged as
      // an error because an expired cookie is the normal end of a session.
      return null;
    }
  }
}
