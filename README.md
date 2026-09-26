# sonde

An OTLP receiver in Rust. Accepts OpenTelemetry traces, metrics and logs over
both transports the spec defines, publishes them to Redpanda, and drains them
into ClickHouse.

```
exporters ──OTLP──▶ receiver ──▶ Redpanda ──▶ consumer ──▶ ClickHouse
                    (4317/4318)   otel.*                    otel_traces, …
```

| Transport | Port | Encodings |
|---|---|---|
| OTLP/gRPC | 4317 | protobuf, gzip in and out |
| OTLP/HTTP | 4318 | `application/x-protobuf`, `application/json`, gzip requests |

`POST /v1/traces`, `/v1/metrics`, `/v1/logs`; `GET /healthz`.

Browsers can export directly once `SONDE_HTTP_CORS_ORIGINS` names their
origin (or `*`). Preflights mirror the requested headers rather than answering
`*`, because the wildcard is defined not to cover `Authorization`.

## Pointing an exporter here

Any stock OTel SDK works unchanged:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318   # or :4317 for gRPC
export OTEL_SERVICE_NAME=my-service
```

From another container, reach the host as `http://host.docker.internal:4318`
(with `host-gateway`); both listeners bind `0.0.0.0`.

Gotchas worth knowing:

- Deno's built-in OTel takes `OTEL_DENO=true`. `OTEL_DENO=1` is rejected
  outright ("only true and false are accepted") and you get silence, not an
  error at the exporter.
- Prefer explicit-bucket histograms; exponential ones are dropped (see below).



## Run

```sh
docker compose up -d
```

Host ports are overridable — copy `.env.example` to `.env` if something already
owns 8123/9000, 19092 or 4317/4318.

The broker is optional. `SONDE_BACKEND=clickhouse` makes receivers write
straight to ClickHouse, which is the simplest thing that works for development:

```sh
SONDE_BACKEND=clickhouse SONDE_ROLE=receiver cargo run --release
```

## Why a broker

Ingest survives ClickHouse being down or slow instead of pushing backpressure
out to every exporter; batches can be replayed after a schema change or an
ingestion bug; and more than one consumer can read the same stream. It also
coalesces bursty writes into the large inserts ClickHouse wants.

The topics carry **raw OTLP protobuf**, not flattened rows — replay is the main
reason the broker is here, and rows already flattened under the old schema would
defeat it. One message per resource, keyed by `service.name`, so a service's
records stay on one partition and in order.

Offsets are committed only after a batch is in ClickHouse, making delivery
at-least-once: a crash between the insert and the commit replays that batch.

## Roles

One binary, three shapes. `SONDE_ROLE=all` runs both halves in one process
(the single-node default); splitting them lets receivers scale on request rate
and consumers on write throughput, with the consumer group dividing partitions
between replicas.

| `SONDE_ROLE` | Runs |
|---|---|
| `receiver` | OTLP endpoints only |
| `consumer` | broker → ClickHouse only |
| `all` | both |

## Configuration

| Variable | Default | |
|---|---|---|
| `SONDE_ROLE` | `all` | `receiver`, `consumer`, `all` |
| `SONDE_BACKEND` | `clickhouse` | `kafka`, `clickhouse`, `log` |
| `SONDE_GRPC_ADDR` | `0.0.0.0:4317` | |
| `SONDE_HTTP_ADDR` | `0.0.0.0:4318` | |
| `SONDE_HTTP_CORS_ORIGINS` | | comma-separated origins, or `*`; empty disables CORS |
| `SONDE_KAFKA_BROKERS` | `localhost:9092` | |
| `SONDE_KAFKA_TOPIC_PREFIX` | `otel` | topics are `<prefix>.traces`, `.metrics`, `.logs` |
| `SONDE_KAFKA_GROUP_ID` | `sonde` | |
| `SONDE_KAFKA_LINGER_MS` | `50` | producer batching window |
| `SONDE_KAFKA_SEND_TIMEOUT_MS` | `10000` | |
| `SONDE_KAFKA_MAX_MESSAGE_BYTES` | `16777216` | |
| `SONDE_KAFKA_BATCH_MESSAGES` | `5000` | consumer flushes at either bound |
| `SONDE_KAFKA_BATCH_WAIT_MS` | `1000` | |
| `SONDE_KAFKA_RETRY_BACKOFF_MS` | `2000` | |
| `SONDE_CLICKHOUSE_URL` | `http://localhost:8123` | |
| `SONDE_CLICKHOUSE_DATABASE` | `otel` | |
| `SONDE_CLICKHOUSE_USER` | `default` | |
| `SONDE_CLICKHOUSE_PASSWORD` | | |
| `SONDE_CLICKHOUSE_TTL_DAYS` | `30` | `0` keeps data forever |
| `SONDE_CLICKHOUSE_CREATE_SCHEMA` | `true` | run the DDL on start |
| `RUST_LOG` | `sonde=info,warn` | |

## Authentication

The read API and console sit behind OIDC. Dex runs in the stack rather than in
the cloud for the same reason the rest of it does: the login path of an
observability tool should not depend on a service that can be down at the
moment you need to look at why something is down.

```
browser ──▶ /api/auth/login ──▶ dex ──▶ /api/auth/callback ──▶ session cookie
```

The session is a signed JWT in an httpOnly cookie (no server-side store, so the
API stays stateless); guarded routes answer `401` with a login URL rather than
redirecting, because every one of them is called by `fetch` or `EventSource`.
Everything except `/api/auth/*` and `/api/health` requires a session.

Users live in `dex/config.yaml`. Dex is a federating provider, so swapping the
static password for GitHub, Google or LDAP is a connector in that file and no
change here. Set `SONDE_AUTH_DISABLED=true` to run without a provider
locally — opt-out by design, so an unauthenticated API is never something you
get by forgetting a variable.

| Variable | Default | |
|---|---|---|
| `SONDE_OIDC_ISSUER` | `http://localhost:5556/dex` | |
| `SONDE_OIDC_CLIENT_ID` | `sonde` | |
| `SONDE_OIDC_CLIENT_SECRET` | | must match `dex/config.yaml` |
| `SONDE_OIDC_REDIRECT_URI` | `http://localhost:4319/api/auth/callback` | must be registered in Dex |
| `SONDE_APP_URL` | `http://localhost:4200` | where login lands |
| `SONDE_SESSION_SECRET` | | signs the session cookie |
| `SONDE_SESSION_HOURS` | `12` | sessions cannot be revoked early, so keep it short |
| `SONDE_SECURE_COOKIES` | `false` | `true` anywhere with TLS |
| `SONDE_AUTH_DISABLED` | `false` | |

Ingest (4317/4318) is **not** authenticated yet.

## Storage

Five tables, created on first start, partitioned by day and ordered by
`(ServiceName, …, Timestamp)`, with a part-level TTL so expiry is a partition
drop rather than a mutation:

- `otel_traces` — events and links as parallel arrays (`EventsName`,
  `LinksTraceId`, …), bloom filters on `TraceId` and attribute keys
- `otel_logs` — token bloom filter on `Body`
- `otel_metrics_gauge`, `otel_metrics_sum`, `otel_metrics_histogram`

Attributes become `Map(LowCardinality(String), String)`; scalar values render as
text, arrays and nested key/value lists keep their OTLP JSON shape. Exponential
histograms, summaries and exemplars have no table yet — those points are dropped
with a `warn` naming the metric, and the batch is still acknowledged.

## Read path

```
Angular (:4200) ──▶ api (:4319) ──▶ ClickHouse
```

TypeScript, on the microphi stack: `@microphi/di` for the container and
`@microgamma/apigator` for the endpoint decorators, with Express underneath.

```sh
cd api  && npm install && npm run build && npm start
cd web  && npm install && npm start          # proxies /api to :4319
```

The API never materialises a result set. `StreamingEventHandler` extends
apigator's Express handler so an endpoint returning a `StreamingResult` gets
ClickHouse's `JSONEachRow` body piped straight at the client as NDJSON, and the
Angular client decodes it line by line — rows appear while the query is still
running, and changing a filter aborts the request in flight.

| Endpoint | | |
|---|---|---|
| `GET /api/services` | JSON | services with span/log counts |
| `POST /api/traces/search` | NDJSON | filters: service, name, status, minDurationMs, from, to, limit |
| `GET /api/traces/{traceId}` | NDJSON | every span of one trace, oldest first |
| `POST /api/logs/search` | NDJSON | filters: service, contains, minSeverity, traceId, from, to, limit |
| `GET /api/traces/tail` | SSE | live spans; filters: service, status |
| `GET /api/logs/tail` | SSE | live records; filters: service, minSeverity, contains |
| `GET /api/health` | JSON | checks ClickHouse is reachable |

Filters reach ClickHouse as bound `{name:Type}` parameters, never as
interpolated SQL.

### Search streams, tails subscribe

The two use different transports on purpose. A search is finite, so it is
chunked NDJSON over `fetch`: it ends when the rows run out, and an
`EventSource` would reconnect and replay it. A tail is open-ended, so it is
SSE: `EventSource` reconnects on its own and resumes from `Last-Event-ID`,
which is what a connection meant to stay open all day needs. The tail also
accepts its filters in the query string, because a GET with no body is all an
`EventSource` can issue.

ClickHouse cannot push, so a tail polls on a watermark held back by ten seconds
and de-duplicates what it re-reads. Without the overlap, any record whose event
timestamp is older than the newest already delivered would be missed — routine
rather than rare with a broker in the ingest path.

The two local packages are consumed through `file:` paths into their checkouts,
which npm materialises as symlinks — edit them and the change is picked up on
the next build, without publishing.

## Tests

```sh
cargo test                                             # unit + gRPC transport

SONDE_TEST_CLICKHOUSE_URL=http://localhost:8123 \
  SONDE_TEST_CLICKHOUSE_USER=sonde \
  SONDE_TEST_CLICKHOUSE_PASSWORD=sonde \
  cargo test --test clickhouse -- --test-threads=1

SONDE_TEST_KAFKA_BROKERS=localhost:19092 \
  SONDE_TEST_CLICKHOUSE_URL=http://localhost:8123 \
  SONDE_TEST_CLICKHOUSE_USER=sonde \
  SONDE_TEST_CLICKHOUSE_PASSWORD=sonde \
  cargo test --test pipeline -- --test-threads=1
```

Both integration suites skip themselves when their environment variables are
unset. They run against real servers on purpose: the ClickHouse client validates
every row against the server's own column types before inserting, so schema
drift surfaces there and nowhere else.

## Building outside a development machine

`api` and `web` depend on `@microphi/*` and `@microgamma/apigator` through
`file:` paths into sibling checkouts. On a machine that has those checkouts
that is the point — edit the package, rebuild here, no publish in between.
Anywhere else, including CI, there is nothing at the other end of the path.

`.github/ci/use-published-packages.mjs` rewrites those entries to the published
versions, which is what CI runs before installing:

```sh
node .github/ci/use-published-packages.mjs api web
npm install --legacy-peer-deps --prefix api   # published apigator still peers on reflect-metadata ^0.1
npm install --prefix web
```

To go back to working against local checkouts, `git checkout` the two
manifests, or `npm link` the packages over the installed copies.

## Licence

MIT. See [LICENSE](LICENSE).

### A caveat on the console build

The console's stores are written against the `makeStore` typings in the working
copy of `@microphi/store`, which are ahead of what is on npm: built against the
published 2.11.0 or 2.11.1, every effect method resolves to `never` and the
build fails. So CI can check the receiver and the API today, and can check the
console from the moment those typings are published.
