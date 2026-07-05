#!/bin/bash
# kimi-backup-daemon.sh - Runs kimi-backup.sh periodically in background
set -e

INTERVAL="${BACKUP_INTERVAL_SEC:-300}"  # default 5 minutes

echo "[backup-daemon] Starting backup daemon (interval: ${INTERVAL}s)"

while true; do
    sleep "$INTERVAL"
    bash /usr/local/bin/kimi-backup.sh 2>&1 | while IFS= read -r line; do
        echo "[backup-daemon] $line"
    done
done
