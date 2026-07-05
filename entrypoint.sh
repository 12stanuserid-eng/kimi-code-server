#!/bin/bash
exec > >(tee /tmp/startup.log) 2>&1

echo "=========================================="
echo "[entrypoint] Started at $(date)"
echo "PORT=${PORT}"
echo "Python: $(python3 --version 2>&1)"
echo "Working dir: $(pwd)"
echo "Files: $(ls -la /app/ 2>&1)"
echo "=========================================="

cd /app

echo "[entrypoint] Starting server on port ${PORT:-10000}..."
exec python3 -m uvicorn server:app --host 0.0.0.0 --port "${PORT:-10000}" --log-level info
