#!/bin/bash
set -e
# Log everything to stdout/stderr so Render captures it
echo "[entrypoint] Starting pentaract..."
echo "[entrypoint] DATABASE_URL: ${DATABASE_URL:0:50}..."
echo "[entrypoint] PORT: $PORT"
echo "[entrypoint] RUST_LOG: $RUST_LOG"

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
    echo "[entrypoint] ERROR: DATABASE_URL is not set!"
    exit 1
fi

# Test database connectivity
echo "[entrypoint] Testing database connection..."
timeout 15 bash -c 'exec 3<>/dev/tcp/db.iakqmubdnmoqimnlifms.supabase.co/5432' 2>&1 && echo "[entrypoint] DB TCP OK" || echo "[entrypoint] DB TCP check failed (might be IPv6 only)"

exec /pentaract
