# Pentaract - Lightweight Docker build with external PostgreSQL (Supabase)
# Stage 1: Build Rust binary
FROM rust:latest AS builder
WORKDIR /app
COPY pentaract .
RUN cargo build --release && cp target/release/pentaract /pentaract

# Stage 2: Build UI
FROM node:22-slim AS ui
WORKDIR /app
COPY ui/package.json ui/pnpm-lock.yaml* ./
RUN npm install -g pnpm@9 && pnpm i
COPY ui .
RUN VITE_API_BASE=/api pnpm run build

# Stage 3: Runtime (no bundled PostgreSQL - using Supabase externally)
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates libgcc-s1 && rm -rf /var/lib/apt/lists/*

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
# Telegram defaults
ENV TELEGRAM_API_BASE_URL=https://api.telegram.org
ENV TELEGRAM_RATE_LIMIT=18

ENTRYPOINT ["/entrypoint.sh"]
