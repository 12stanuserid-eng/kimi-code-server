#!/bin/bash
set -x
echo "[ENTRY] Starting pentaract at $(date)"
echo "[ENTRY] PORT=$PORT"
echo "[ENTRY] Checking binary..."
ls -la /pentaract 2>&1
echo "[ENTRY] Binary file type:"
file /pentaract 2>&1 || echo "BINARY NOT FOUND!"
echo "[ENTRY] LDD check:"
ldd /pentaract 2>&1 || echo "ldd not available or binary not found"
echo "[ENTRY] Starting binary with RUST_BACKTRACE=full..."
RUST_BACKTRACE=full RUST_LOG=debug /pentaract 2>&1
EXIT_CODE=$?
echo "[ENTRY] Binary exited with code $EXIT_CODE at $(date)"
# Keep container alive for debugging
echo "[ENTRY] Sleeping for 1 hour for debugging..."
sleep 3600
