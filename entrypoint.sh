#!/bin/bash
set -e
echo "=========================================="
echo "[entrypoint] Started at $(date)"
echo "PORT=${PORT}"
echo "Python: $(python3 --version 2>&1)"
echo "=========================================="

cd /app

echo "[entrypoint] Starting server..."
exec python3 -m uvicorn server:app --host 0.0.0.0 --port "${PORT:-10000}" --log-level info 2>&1
