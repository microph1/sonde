import { Inject, Injectable } from '@microphi/di';
import { getDebugger } from '@microphi/debug';
import type { Express, NextFunction, Request, Response } from 'express';

import { configFromEnv } from '../config';
import { LoginStates } from './login-state';
import { Oidc } from './oidc';
import { Sessions } from './session';

const d = getDebugger('watchers:api:auth');

/**
 * The login flow, mounted as plain Express routes rather than as an apigator
 * `@Endpoint`.
 *
 * Those decorators describe request-in/JSON-out handlers; every route here
 * exists to set a cookie and issue a redirect instead, so expressing them as
 * lambdas would mean bending the handler further for no gain. They stay in the
 * container, so the OIDC client and session signer are still injected.
 */
@Injectable()
export class AuthRoutes {
  private readonly config = configFromEnv().auth;

  constructor(
    @Inject(Oidc) private oidc: Oidc,
    @Inject(Sessions) private sessions: Sessions,
    @Inject(LoginStates) private loginStates: LoginStates,
  ) {}

  mount(app: Express): void {
    app.get('/api/auth/login', (req, res) => void this.login(req, res));
    app.get('/api/auth/callback', (req, res) => void this.callback(req, res));
    app.post('/api/auth/logout', (req, res) => void this.logout(req, res));
    app.get('/api/auth/me', (req, res) => void this.me(req, res));
  }

  /** Guards everything except the login routes and the health check. */
  guard() {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      if (!this.config.enabled || isPublic(req)) {
        next();
        return;
      }

      const user = await this.sessions.read(req);

      if (!user) {
        // 401 with a login URL rather than a redirect: every guarded route is
        // called by fetch or EventSource, and a 302 to an HTML login page would
        // arrive as an unparseable body instead of a signal to re-authenticate.
        res.status(401).json({ error: 'not authenticated', login: '/api/auth/login' });
        return;
      }

      next();
    };
  }

  private async login(_req: Request, res: Response): Promise<void> {
    try {
      const request = await this.oidc.authorizationRequest();
      await this.loginStates.store(request, res);
      res.redirect(request.url);
    } catch (error) {
      d('login failed', error);
      res.status(502).json({ error: 'identity provider unavailable' });
    }
  }

  private async callback(req: Request, res: Response): Promise<void> {
    try {
      const expected = await this.loginStates.take(req, res);
      const currentUrl = new URL(req.originalUrl, this.config.redirectUri);
      const user = await this.oidc.exchange(currentUrl, expected);

      // `res.cookie` appends, so clearing the login state and issuing the
      // session both survive into the response.
      await this.sessions.issue(user, res);

      res.redirect(this.config.appUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      d('callback failed', message);
      res.status(status(message)).json({ error: strip(message) });
    }
  }

  private async logout(_req: Request, res: Response): Promise<void> {
    this.sessions.clear(res);
    res.status(204).end();
  }

  private async me(req: Request, res: Response): Promise<void> {
    const user = await this.sessions.read(req);

    if (!user && this.config.enabled) {
      res.status(401).json({ error: 'not authenticated', login: '/api/auth/login' });
      return;
    }

    res.json(user ?? { sub: 'anonymous', email: '', name: 'anonymous' });
  }
}

/** Health is public so a probe does not need a credential, and the login routes
 * obviously cannot require a session. */
function isPublic(req: Request): boolean {
  return req.path.startsWith('/api/auth/') || req.path === '/api/health';
}

function status(message: string): number {
  const match = message.match(/^\[(\d{3,})\]/);
  return match ? Number(match[1]) : 400;
}

function strip(message: string): string {
  return message.replace(/^\[\d{3,}\]\s*/, '');
}
