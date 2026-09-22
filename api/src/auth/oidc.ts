import { Injectable } from '@microphi/di';
import { getDebugger } from '@microphi/debug';
import * as client from 'openid-client';

import { configFromEnv } from '../config';
import { SessionUser } from './session';

const d = getDebugger('watchers:api:oidc');

export interface AuthorizationRequest {
  readonly url: string;
  /** Held by the caller for the duration of the round trip. */
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
}

/**
 * The authorization-code half of the login, against whichever OIDC provider is
 * configured. Nothing here is Dex-specific — it is all discovery-driven, so
 * pointing `WATCHERS_OIDC_ISSUER` at something else is the whole migration.
 */
@Injectable()
export class Oidc {
  private readonly config = configFromEnv().auth;
  private discovered?: Promise<client.Configuration>;

  /** Discovery is cached: it is one network call whose answer changes about as
   * often as the provider is redeployed, and the login path should not pay for
   * it every time. */
  private configuration(): Promise<client.Configuration> {
    this.discovered ??= this.discover();

    return this.discovered;
  }

  private async discover(): Promise<client.Configuration> {
    const issuer = new URL(this.config.issuer);
    // openid-client refuses plain HTTP, which is the right default: tokens and
    // the code would otherwise cross the wire in clear. A local Dex has no
    // certificate, so the exception is explicit, narrow, and loud.
    const insecure = issuer.protocol === 'http:';

    if (insecure) {
      // eslint-disable-next-line no-console
      console.warn(`oidc issuer ${issuer.origin} is plain HTTP — do not do this off localhost`);
    }

    const configuration = await client.discovery(
      issuer,
      this.config.clientId,
      this.config.clientSecret,
      undefined,
      insecure ? { execute: [client.allowInsecureRequests] } : undefined,
    );

    if (insecure) {
      // Discovery's opt-in does not carry over to the token request.
      client.allowInsecureRequests(configuration);
    }

    return configuration;
  }

  async authorizationRequest(): Promise<AuthorizationRequest> {
    const configuration = await this.configuration();

    const verifier = client.randomPKCECodeVerifier();
    const challenge = await client.calculatePKCECodeChallenge(verifier);
    const state = client.randomState();
    const nonce = client.randomNonce();

    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: this.config.redirectUri,
      scope: 'openid email profile',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });

    return { url: url.href, state, nonce, verifier };
  }

  /**
   * Exchanges the code for tokens and returns the verified identity.
   *
   * `expectedState` and `expectedNonce` are checked by the library; without
   * them the callback would accept a code obtained in someone else's browser.
   */
  async exchange(
    currentUrl: URL,
    expected: { state: string; nonce: string; verifier: string },
  ): Promise<SessionUser> {
    const configuration = await this.configuration();

    const tokens = await client.authorizationCodeGrant(configuration, currentUrl, {
      pkceCodeVerifier: expected.verifier,
      expectedState: expected.state,
      expectedNonce: expected.nonce,
      idTokenExpected: true,
    });

    const claims = tokens.claims();

    if (!claims?.sub) {
      throw new Error('[502] identity provider returned no subject');
    }

    d('authenticated', claims.sub);

    return {
      sub: claims.sub,
      email: typeof claims['email'] === 'string' ? claims['email'] : '',
      name:
        typeof claims['name'] === 'string'
          ? claims['name']
          : typeof claims['preferred_username'] === 'string'
            ? claims['preferred_username']
            : '',
    };
  }
}
