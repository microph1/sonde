import { Body, Endpoint, Lambda, Path } from '@microgamma/apigator';
import { Inject } from '@microphi/di';

import { App, ApiKey, AppsService, IssuedKey, KeyKind } from '../apps/apps.service';
import { InjectableEndpoint } from '../server/injectable-endpoint';

export interface CreateAppBody {
  readonly name: string;
}

export interface CreateKeyBody {
  readonly appId: string;
  readonly kind: KeyKind;
  readonly name: string;
  /** Required in practice for a public key; ignored for a secret one. */
  readonly origins?: string[];
}

@Endpoint({
  name: 'apps',
  basePath: '/api',
  cors: true,
})
@InjectableEndpoint()
export class AppsEndpoint {
  constructor(@Inject(AppsService) private apps: AppsService) {}

  @Lambda({ method: 'GET', path: '/apps' })
  public async list(): Promise<App[]> {
    return this.apps.listApps();
  }

  @Lambda({ method: 'POST', path: '/apps' })
  public async create(@Body() body: CreateAppBody): Promise<App> {
    return this.apps.createApp(body?.name ?? '');
  }

  @Lambda({ method: 'DELETE', path: '/apps/{appId}' })
  public async remove(@Path('appId') appId: string): Promise<{ deleted: string }> {
    await this.apps.deleteApp(appId);

    return { deleted: appId };
  }

  @Lambda({ method: 'GET', path: '/keys' })
  public async keys(@Path('appId') appId?: string): Promise<ApiKey[]> {
    return this.apps.listKeys(appId);
  }

  /** The response carries the secret; it is the only time it exists anywhere
   * outside the caller's hands. */
  @Lambda({ method: 'POST', path: '/keys' })
  public async issue(@Body() body: CreateKeyBody): Promise<IssuedKey> {
    return this.apps.createKey({
      appId: body?.appId ?? '',
      kind: body?.kind ?? 'secret',
      name: body?.name ?? '',
      origins: body?.origins ?? [],
    });
  }

  @Lambda({ method: 'DELETE', path: '/keys/{keyId}' })
  public async revoke(@Path('keyId') keyId: string): Promise<{ revoked: string }> {
    await this.apps.revokeKey(keyId);

    return { revoked: keyId };
  }
}
