ARG CODEX_VERSION=0.144.6
ARG BASE_IMAGE=node:24-bookworm-slim
FROM python:3.12-slim-bookworm AS python-runtime

FROM rust:bookworm AS proxy-builder
ARG CODEX_VERSION
RUN git clone --depth 1 --branch "rust-v${CODEX_VERSION}" https://github.com/openai/codex.git /src/codex
WORKDIR /src/codex/codex-rs
COPY network-proxy-main.rs /src/codex/codex-rs/network-proxy/src/main.rs
RUN sed -i '/^tokio =/a toml = { workspace = true }' network-proxy/Cargo.toml \
    && cargo build --release -p codex-network-proxy --bin codex-network-proxy

FROM ${BASE_IMAGE}
ARG CODEX_VERSION

COPY --from=python-runtime /usr/local /usr/local

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        curl \
        git \
        libgdbm6 \
        libgssapi-krb5-2 \
        libk5crypto3 \
        libkeyutils1 \
        libkrb5-3 \
        libkrb5support0 \
        libncursesw6 \
        libnsl2 \
        libreadline8 \
        libsqlite3-0 \
        libssl3 \
        libtirpc-common \
        libtirpc3 \
        netbase \
        openssl \
        readline-common \
        ripgrep \
        tini \
    && rm -rf /var/lib/apt/lists/* \
    && python3.12 --version \
    && python3.12 -m pip --version \
    && python3.12 -m venv /tmp/python-smoke \
    && rm -rf /tmp/python-smoke \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && useradd --create-home --uid 10001 --shell /bin/bash codex \
    && mkdir -p /home/codex/.codex /proxy-shared \
    && chown -R codex:codex /home/codex /proxy-shared

COPY --from=proxy-builder /src/codex/codex-rs/target/release/codex-network-proxy /usr/local/bin/codex-network-proxy
COPY proxy-sidecar.mjs /usr/local/lib/local-engineer/proxy-sidecar.mjs

ENV CODEX_HOME=/home/codex/.codex
WORKDIR /workspace
USER codex
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
