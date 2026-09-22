import 'reflect-metadata';

import { LambdaDefaultHandler } from '@microgamma/apigator';
import { DI, bootstrap, injector } from '@microphi/di';
import { getDebugger } from '@microphi/debug';

import { AppsService } from './apps/apps.service';
import { AuthRoutes } from './auth/auth-routes';
import { LoginStates } from './auth/login-state';
import { Oidc } from './auth/oidc';
import { Sessions } from './auth/session';
import { ClickHouseService } from './clickhouse/clickhouse.service';
import { configFromEnv } from './config';
import { LogsEndpoint } from './endpoints/logs.endpoint';
import { AppsEndpoint } from './endpoints/apps.endpoint';
import { ServicesEndpoint } from './endpoints/services.endpoint';
import { TracesEndpoint } from './endpoints/traces.endpoint';
import { createApp } from './server/express-app';
import { StreamingEventHandler } from './server/streaming.handler';

/**
 * Swapping `LambdaDefaultHandler` here is what turns every endpoint in the
 * container into one that can stream — no endpoint knows about Express.
 */
@DI({
  providers: [
    ClickHouseService,
    AppsService,
    AppsEndpoint,
    Oidc,
    Sessions,
    LoginStates,
    AuthRoutes,
    TracesEndpoint,
    LogsEndpoint,
    ServicesEndpoint,
    { provide: LambdaDefaultHandler, useClass: StreamingEventHandler },
  ],
})
export class Api {}

const d = getDebugger('watchers:api');

export async function start(): Promise<void> {
  const config = configFromEnv();

  bootstrap(Api);

  // Apps and keys are configuration this API owns, so it creates their tables
  // the way the receiver creates the telemetry ones.
  await injector(AppsService).ensureSchema();

  const app = createApp(
    config,
    [
      injector(TracesEndpoint),
      injector(LogsEndpoint),
      injector(ServicesEndpoint),
      injector(AppsEndpoint),
    ],
    injector(AuthRoutes),
  );

  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`watchers api listening on :${config.port} → ${config.clickhouse.url}`);
    d('started', config);
  });
}

if (require.main === module) {
  start().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('failed to start', error);
    process.exitCode = 1;
  });
}
