# Stage 1: Build Rust binary with limited parallelism for low-memory env
FROM rust:bookworm AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
COPY pentaract .
ENV CARGO_BUILD_JOBS=2
RUN cargo build --release && cp target/release/pentaract /pentaract

# Stage 2: Runtime
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates curl libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /pentaract /pentaract
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

EXPOSE 10000
ENV RUST_BACKTRACE=1
CMD ["/pentaract"]
