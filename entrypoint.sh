#!/bin/bash
# Log all output to stdout for Render log capture
echo "=========================================="
echo "[entrypoint] Pentaract startup - $(date)"
echo "[entrypoint] RUST_LOG=${RUST_LOG}"
echo "[entrypoint] PORT=${PORT}"
echo "[entrypoint] DATABASE_URL prefix: ${DATABASE_URL:0:50}..."
echo "=========================================="

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
    echo "[entrypoint] WARNING: DATABASE_URL not set, pentaract will fail"
fi

echo "[entrypoint] Starting pentaract with full backtrace..."
echo "[entrypoint] Command: /pentaract"
echo "=========================================="

# Run pentaract directly and capture output
/pentaract 2>&1

# If pentaract exits, log it
EXIT_CODE=$?
echo "[entrypoint] Pentaract exited with code: ${EXIT_CODE}"
echo "[entrypoint] Time: $(date)"

# Keep container alive for debugging (sleep 5 min then exit)
sleep 10
exit ${EXIT_CODE}
