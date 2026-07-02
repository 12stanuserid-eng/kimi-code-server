#!/bin/bash
echo "=========================================="
echo "[entrypoint started] $(date)"
echo "PORT=${PORT}"
echo "=========================================="

echo "[entrypoint] Running: /pentaract"
/pentaract > /tmp/pentaract.log 2>&1
EXIT_CODE=$?
echo "[entrypoint] exited code=${EXIT_CODE} at $(date)"
cat /tmp/pentaract.log
sleep 5
exit ${EXIT_CODE}
