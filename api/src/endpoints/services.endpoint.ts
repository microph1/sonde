import { Endpoint, Lambda } from '@microgamma/apigator';
import { Inject } from '@microphi/di';

import { InjectableEndpoint } from '../server/injectable-endpoint';

import { ClickHouseService } from '../clickhouse/clickhouse.service';

export interface ServiceSummary {
  readonly ServiceName: string;
  readonly traces: string;
  readonly logs: string;
  readonly lastSeen: string;
}

@Endpoint({
  name: 'services',
  basePath: '/api',
  cors: true,
})
@InjectableEndpoint()
export class ServicesEndpoint {
  constructor(@Inject(ClickHouseService) private clickhouse: ClickHouseService) {}

  /**
   * The navigation root for the UI. Bounded by the number of services rather
   * than the volume of telemetry, so this one is materialised rather than
   * streamed.
   */
  @Lambda({ method: 'GET', path: '/services' })
  public async list(): Promise<ServiceSummary[]> {
    return this.clickhouse.rows<ServiceSummary>(
      `SELECT ServiceName,
              sum(traces) AS traces,
              sum(logs) AS logs,
              max(lastSeen) AS lastSeen
       FROM (
         SELECT ServiceName, count() AS traces, 0 AS logs, max(Timestamp) AS lastSeen
         FROM otel_traces GROUP BY ServiceName
         UNION ALL
         SELECT ServiceName, 0 AS traces, count() AS logs, max(Timestamp) AS lastSeen
         FROM otel_logs GROUP BY ServiceName
       )
       GROUP BY ServiceName
       ORDER BY lastSeen DESC`,
    );
  }

  @Lambda({ method: 'GET', path: '/health' })
  public async health(): Promise<{ status: string }> {
    await this.clickhouse.rows('SELECT 1 AS ok');
    return { status: 'ok' };
  }
}
