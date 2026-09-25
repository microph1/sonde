FROM rust:1.90-slim-bookworm AS builder

# librdkafka is built from source by rdkafka-sys.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        cmake g++ make python3 \
        libsasl2-dev libssl-dev pkg-config zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Build the dependency graph against a stub so that editing src/ does not
# invalidate the layer holding the ~200 crates this pulls in.
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src \
    && echo 'fn main() {}' > src/main.rs \
    && echo '' > src/lib.rs \
    && cargo build --release \
    && rm -rf src

COPY src ./src
# cargo stats the mtime of sources; the stub build left the stale fingerprint.
RUN touch src/main.rs src/lib.rs && cargo build --release

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 sonde
COPY --from=builder /build/target/release/sonde /usr/local/bin/sonde
USER sonde
EXPOSE 4317 4318
ENTRYPOINT ["/usr/local/bin/sonde"]
