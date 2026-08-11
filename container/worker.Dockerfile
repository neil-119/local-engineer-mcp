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

FROM rust:bookworm AS rust-runtime

FROM ${BASE_IMAGE}
ARG CODEX_VERSION

COPY --from=python-runtime /usr/local /usr/local
COPY --from=rust-runtime /usr/local/cargo /usr/local/cargo
COPY --from=rust-runtime /usr/local/rustup /usr/local/rustup

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        build-essential \
        curl \
        file \
        git \
        libayatana-appindicator3-dev \
        libgtk-3-dev \
        libssl-dev \
        libwebkit2gtk-4.1-dev \
        libxdo-dev \
        librsvg2-dev \
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
        patchelf \
        pkg-config \
        readline-common \
        ripgrep \
        tini \
    && rm -rf /var/lib/apt/lists/* \
    && python3.12 --version \
    && python3.12 -m pip --version \
    && python3.12 -m venv /tmp/python-smoke \
    && rm -rf /tmp/python-smoke \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && RUSTUP_HOME=/usr/local/rustup /usr/local/cargo/bin/rustup component add rustfmt clippy \
    && useradd --create-home --uid 10001 --shell /bin/bash codex \
    && mkdir -p /home/codex/.cargo /home/codex/.codex /proxy-shared \
    && chown -R codex:codex /home/codex /proxy-shared

COPY --from=proxy-builder /src/codex/codex-rs/target/release/codex-network-proxy /usr/local/bin/codex-network-proxy
COPY proxy-sidecar.mjs /usr/local/lib/local-engineer/proxy-sidecar.mjs
COPY apply_patch /usr/local/bin/apply_patch
COPY apply_patch.mjs /usr/local/lib/local-engineer/apply_patch.mjs
COPY rust-path.sh /etc/profile.d/local-engineer-rust.sh
RUN chmod 0755 /usr/local/bin/apply_patch /etc/profile.d/local-engineer-rust.sh

ENV CODEX_HOME=/home/codex/.codex \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/home/codex/.cargo \
    PATH=/usr/local/cargo/bin:${PATH}
WORKDIR /workspace
USER codex
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
