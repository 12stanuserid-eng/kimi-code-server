#!/bin/bash
cd /root/kimi-code-server/pentaract

export $(grep -v '^#' .env | xargs)

LOG_FILE="/tmp/pentaract.log"
PID_FILE="/tmp/pentaract.pid"

cleanup() {
    echo "[$(date)] Shutting down..." >> "$LOG_FILE"
    kill $(jobs -p) 2>/dev/null
    exit 0
}
trap cleanup SIGTERM SIGINT

echo "[$(date)] Pentarct 24/7 wrapper starting..." >> "$LOG_FILE"

echo "Starting with env:" >> "$LOG_FILE"
echo "DATABASE_HOST=$DATABASE_HOST" >> "$LOG_FILE"
echo "DATABASE_PORT=$DATABASE_PORT" >> "$LOG_FILE"
echo "PORT=$PORT" >> "$LOG_FILE"

while true; do
    echo "[$(date)] Starting pentaract server..." >> "$LOG_FILE"
    echo $$ > "$PID_FILE"
    RUST_LOG=info RUST_BACKTRACE=1 ./target/release/pentaract >> "$LOG_FILE" 2>&1
    EXIT_CODE=$?
    echo "[$(date)] Pentarct exited with code $EXIT_CODE, restarting in 5s..." >> "$LOG_FILE"
    sleep 5
done
