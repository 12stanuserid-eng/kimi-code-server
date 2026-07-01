# Pentaract - Self-contained Docker build with bundled PostgreSQL
# Stage 1: Build Rust binary
FROM rust:latest AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
COPY pentaract .
RUN cargo build --release && cp target/release/pentaract /pentaract

# Stage 2: Build UI
FROM node:22-slim AS ui
WORKDIR /app
COPY ui/package.json ui/pnpm-lock.yaml* ./
RUN npm install -g pnpm@9 && pnpm i
COPY ui .
RUN VITE_API_BASE=/api pnpm run build

# Stage 3: Runtime with bundled PostgreSQL
FROM debian:bookworm-slim

# Install PostgreSQL 15 and runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl3 \
    postgresql-15 \
    postgresql-client-15 \
    && rm -rf /var/lib/apt/lists/*

# Copy application binaries and UI
COPY --from=builder /pentaract /pentaract
COPY --from=ui /app/dist /ui
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

# Copy entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 10000

ENV RUST_BACKTRACE=full
ENV RUST_LOG=debug
# Local PostgreSQL connection (bundled)
ENV DATABASE_HOST=localhost
ENV DATABASE_PORT=5432
ENV DATABASE_USER=pentaract
ENV DATABASE_PASSWORD=pentaract
ENV DATABASE_NAME=pentaract
ENV DATABASE_SSL_MODE=disable
# Telegram defaults
ENV TELEGRAM_API_BASE_URL=https://api.telegram.org
ENV TELEGRAM_RATE_LIMIT=18

ENTRYPOINT ["/entrypoint.sh"]
