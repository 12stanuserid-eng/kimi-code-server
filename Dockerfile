# Pentaract - Build from source directly on Render
# Stage 1: Build Rust binary
FROM rust:1.75-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
RUN mkdir -p pentaract/src
COPY pentaract/Cargo.toml pentaract/Cargo.lock pentaract/
COPY pentaract/src pentaract/src
RUN cd pentaract && cargo build --release --jobs 2 && cp target/release/pentaract /pentaract

# Stage 2: Build UI
FROM node:22-slim AS ui
WORKDIR /app
COPY ui/package.json ui/pnpm-lock.yaml* ./
RUN npm install -g pnpm@9 && pnpm i
COPY ui .
RUN VITE_API_BASE=/api pnpm run build

# Stage 3: Runtime
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /pentaract /pentaract
COPY --from=ui /app/dist /ui
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
EXPOSE 10000
ENV RUST_BACKTRACE=full
ENV RUST_LOG=debug
ENTRYPOINT ["/pentaract"]
