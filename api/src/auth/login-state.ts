import { Injectable } from '@microphi/di';
import { SignJWT, jwtVerify } from 'jose';
import type { Request, Response } from 'express';

import { configFromEnv } from '../config';
import { readCookie } from './cookies';

export interface LoginState {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
}

const LOGIN_COOKIE = 'watchers_login';
/** A login round trip is a redirect and a form post; ten minutes is generous. */
const TTL_SECONDS = 600;

/**
 * Carries the PKCE verifier, state and nonce across the redirect to the
 * identity provider.
 *
 * In a short-lived signed cookie rather than server memory, so that the request
 * that starts the login and the callback that finishes it need not land on the
 * same instance — and so that a restart mid-login is merely a retry.
 */
@Injectable()
export class LoginStates {
  private readonly config = configFromEnv().auth;
  private readonly secret = new TextEncoder().encode(configFromEnv().auth.sessionSecret);

  async store(value: LoginState, res: Response): Promise<void> {
    const token = await new SignJWT({ ...value })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(`${TTL_SECONDS}s`)
      .sign(this.secret);

    res.cookie(LOGIN_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.secureCookies,
      path: '/',
      maxAge: TTL_SECONDS * 1000,
    });
  }

  async take(req: Request, res: Response): Promise<LoginState> {
    const token = readCookie(req, LOGIN_COOKIE);

    if (!token) {
      throw new Error('[400] no login in progress');
    }

    // One use only: a replayed callback must not be able to reuse the verifier.
    res.clearCookie(LOGIN_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.secureCookies,
      path: '/',
    });

    try {
      const { payload } = await jwtVerify(token, this.secret);

      return {
        state: String(payload['state']),
        nonce: String(payload['nonce']),
        verifier: String(payload['verifier']),
      };
    } catch {
      throw new Error('[400] the login took too long, start again');
    }
  }
}
