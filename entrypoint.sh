#!/bin/bash
echo "=========================================="
echo "[entrypoint] Started at $(date)"
echo "PORT=${PORT}"
echo "WORKERS=${WORKERS:-4}"
echo "=========================================="

echo "[entrypoint] Starting Python FastAPI server..."
cd /app
python3 -m uvicorn server:app --host 0.0.0.0 --port "${PORT:-10000}" --workers "${WORKERS:-4}" --log-level info 2>&1
EXIT_CODE=$?
echo "[entrypoint] Server exited with code=${EXIT_CODE} at $(date)"
sleep 5
exit ${EXIT_CODE}
