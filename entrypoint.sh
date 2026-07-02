#!/bin/bash
echo "=========================================="
echo "[entrypoint] Started at $(date)"
echo "PORT=${PORT}"
echo "RUST_LOG=${RUST_LOG}"
echo "=========================================="

echo "[entrypoint] Running: /pentaract"
/pentaract 2>&1
EXIT_CODE=$?
echo "[entrypoint] Pentaract exited with code=${EXIT_CODE} at $(date)"

# Try to get diagnostic info
if [ ${EXIT_CODE} -ne 0 ]; then
    echo "[entrypoint] Binary info:"
    file /pentaract 2>&1
    ldd /pentaract 2>&1 || echo "(ldd not available)"
fi

sleep 10
exit ${EXIT_CODE}
