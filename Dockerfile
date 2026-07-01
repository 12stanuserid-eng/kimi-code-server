# Pentaract - Self-contained build (no external registry needed)
# Stage 1: Build Rust binary with limited parallelism
FROM rust:1.75-slim-bookworm AS builder
WORKDIR /app/pentaract
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
COPY pentaract/Cargo.toml pentaract/Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release --jobs 2 2>/dev/null; true
COPY pentaract/src ./src
RUN touch src/main.rs && cargo build --release --jobs 2 && cp target/release/pentaract /pentaract

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
