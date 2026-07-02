# Pentaract - Fixed glibc compatibility
# Stage 1: Build Rust binary on debian:bookworm (matches runtime)
FROM rust:slim-bookworm AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
COPY pentaract .
RUN cargo build --release && cp target/release/pentaract /pentaract

# Stage 2: Build UI
FROM node:22-bookworm-slim AS ui
WORKDIR /app
COPY ui/package.json ui/pnpm-lock.yaml* ./
RUN npm install -g pnpm@9 && pnpm i
COPY ui .
RUN VITE_API_BASE=/api pnpm run build

# Stage 3: Runtime - uses same glibc as build stage
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /pentaract /pentaract
COPY --from=ui /app/dist /ui
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 10000
ENV RUST_BACKTRACE=full
ENV RUST_LOG=debug
ENTRYPOINT ["/bin/bash", "/entrypoint.sh"]
