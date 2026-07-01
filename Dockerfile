# Pentaract - Lightweight Docker build with external PostgreSQL (Supabase)
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

# Stage 3: Runtime (no bundled PostgreSQL - using Supabase externally)
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl3 \
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
# External PostgreSQL (Supabase)
ENV DATABASE_HOST=db.iakqmubdnmoqimnlifms.supabase.co
ENV DATABASE_PORT=5432
ENV DATABASE_USER=postgres
ENV DATABASE_PASSWORD=SARFRAZco1%40
ENV DATABASE_NAME=postgres
ENV DATABASE_SSL_MODE=require

ENTRYPOINT ["/entrypoint.sh"]
