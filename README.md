# the-watchers

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

Browsers can export directly once `WATCHERS_HTTP_CORS_ORIGINS` names their
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

The broker is optional. `WATCHERS_BACKEND=clickhouse` makes receivers write
straight to ClickHouse, which is the simplest thing that works for development:

```sh
WATCHERS_BACKEND=clickhouse WATCHERS_ROLE=receiver cargo run --release
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

One binary, three shapes. `WATCHERS_ROLE=all` runs both halves in one process
(the single-node default); splitting them lets receivers scale on request rate
and consumers on write throughput, with the consumer group dividing partitions
between replicas.

| `WATCHERS_ROLE` | Runs |
|---|---|
| `receiver` | OTLP endpoints only |
| `consumer` | broker → ClickHouse only |
| `all` | both |

## Configuration

| Variable | Default | |
|---|---|---|
| `WATCHERS_ROLE` | `all` | `receiver`, `consumer`, `all` |
| `WATCHERS_BACKEND` | `clickhouse` | `kafka`, `clickhouse`, `log` |
| `WATCHERS_GRPC_ADDR` | `0.0.0.0:4317` | |
| `WATCHERS_HTTP_ADDR` | `0.0.0.0:4318` | |
| `WATCHERS_HTTP_CORS_ORIGINS` | | comma-separated origins, or `*`; empty disables CORS |
| `WATCHERS_KAFKA_BROKERS` | `localhost:9092` | |
| `WATCHERS_KAFKA_TOPIC_PREFIX` | `otel` | topics are `<prefix>.traces`, `.metrics`, `.logs` |
| `WATCHERS_KAFKA_GROUP_ID` | `watchers` | |
| `WATCHERS_KAFKA_LINGER_MS` | `50` | producer batching window |
| `WATCHERS_KAFKA_SEND_TIMEOUT_MS` | `10000` | |
| `WATCHERS_KAFKA_MAX_MESSAGE_BYTES` | `16777216` | |
| `WATCHERS_KAFKA_BATCH_MESSAGES` | `5000` | consumer flushes at either bound |
| `WATCHERS_KAFKA_BATCH_WAIT_MS` | `1000` | |
| `WATCHERS_KAFKA_RETRY_BACKOFF_MS` | `2000` | |
| `WATCHERS_CLICKHOUSE_URL` | `http://localhost:8123` | |
| `WATCHERS_CLICKHOUSE_DATABASE` | `otel` | |
| `WATCHERS_CLICKHOUSE_USER` | `default` | |
| `WATCHERS_CLICKHOUSE_PASSWORD` | | |
| `WATCHERS_CLICKHOUSE_TTL_DAYS` | `30` | `0` keeps data forever |
| `WATCHERS_CLICKHOUSE_CREATE_SCHEMA` | `true` | run the DDL on start |
| `RUST_LOG` | `the_watchers=info,warn` | |

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
| `GET /api/health` | JSON | checks ClickHouse is reachable |

Filters reach ClickHouse as bound `{name:Type}` parameters, never as
interpolated SQL.

The two local packages are consumed through `file:` paths into their checkouts,
which npm materialises as symlinks — edit them and the change is picked up on
the next build, without publishing.

## Tests

```sh
cargo test                                             # unit + gRPC transport

WATCHERS_TEST_CLICKHOUSE_URL=http://localhost:8123 \
  WATCHERS_TEST_CLICKHOUSE_USER=watchers \
  WATCHERS_TEST_CLICKHOUSE_PASSWORD=watchers \
  cargo test --test clickhouse -- --test-threads=1

WATCHERS_TEST_KAFKA_BROKERS=localhost:19092 \
  WATCHERS_TEST_CLICKHOUSE_URL=http://localhost:8123 \
  WATCHERS_TEST_CLICKHOUSE_USER=watchers \
  WATCHERS_TEST_CLICKHOUSE_PASSWORD=watchers \
  cargo test --test pipeline -- --test-threads=1
```

Both integration suites skip themselves when their environment variables are
unset. They run against real servers on purpose: the ClickHouse client validates
every row against the server's own column types before inserting, so schema
drift surfaces there and nowhere else.
