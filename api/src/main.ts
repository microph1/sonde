import 'reflect-metadata';

import { LambdaDefaultHandler } from '@microgamma/apigator';
import { DI, bootstrap, injector } from '@microphi/di';
import { getDebugger } from '@microphi/debug';

import { ClickHouseService } from './clickhouse/clickhouse.service';
import { configFromEnv } from './config';
import { LogsEndpoint } from './endpoints/logs.endpoint';
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
    TracesEndpoint,
    LogsEndpoint,
    ServicesEndpoint,
    { provide: LambdaDefaultHandler, useClass: StreamingEventHandler },
  ],
})
export class Api {}

const d = getDebugger('watchers:api');

export function start(): void {
  const config = configFromEnv();

  bootstrap(Api);

  const app = createApp(config, [
    injector(TracesEndpoint),
    injector(LogsEndpoint),
    injector(ServicesEndpoint),
  ]);

  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`watchers api listening on :${config.port} → ${config.clickhouse.url}`);
    d('started', config);
  });
}

if (require.main === module) {
  start();
}
