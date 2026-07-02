#!/bin/bash
set -e
echo "=========================================="
echo "[entrypoint] Started at $(date)"
echo "PORT=${PORT}"
echo "WORKERS=${WORKERS:-4}"
echo "Python: $(python3 --version 2>&1)"
echo "=========================================="

cd /app

echo "[entrypoint] Testing imports..."
python3 -c "
import sys
print('Python ' + sys.version)
modules = ['fastapi', 'uvicorn', 'sqlalchemy', 'asyncpg', 'httpx', 'jose', 'passlib']
for m in modules:
    try:
        __import__(m)
        print(f'  ✓ {m} imported')
    except Exception as e:
        print(f'  ✗ {m} FAILED: {e}')
        sys.exit(1)
print('All imports OK')
" 2>&1

echo "[entrypoint] Starting server..."
python3 -m uvicorn server:app --host 0.0.0.0 --port "${PORT:-10000}" --workers "${WORKERS:-4}" --log-level debug 2>&1
EXIT_CODE=$?
echo "[entrypoint] Server exited with code=${EXIT_CODE} at $(date)"
sleep 10
exit ${EXIT_CODE}
