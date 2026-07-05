#!/bin/bash
# kimi-backup.sh - Backup ~/.kimi-code/ to Pentaract Telegram storage
set -e

PENTARACT_URL="${PENTARACT_URL:-https://pentaract-f4ga.onrender.com}"
PENTARACT_EMAIL="${PENTARACT_EMAIL:-admin@pentaract.com}"
PENTARACT_PASS="${PENTARACT_PASS:-admin123}"
STORAGE_NAME="${STORAGE_NAME:-kimi-backup}"
KIMI_HOME="${KIMI_HOME:-/root}"
CURL_TIMEOUT="${CURL_TIMEOUT:-120}"
UPLOAD_TIMEOUT="${UPLOAD_TIMEOUT:-300}"

log() { echo "[backup] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# --- Step 1: Login ---
login() {
    log "Logging in..."
    RESP=$(curl -s --max-time 30 -X POST "$PENTARACT_URL/api/auth/login" \
        -d "email=$PENTARACT_EMAIL" \
        -d "password=$PENTARACT_PASS")
    TOKEN=$(echo "$RESP" | node -e "
        let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            try{ const j=JSON.parse(d); console.log(j.access_token||''); }catch(e){ console.log(''); }
        });
    ")
    if [ -z "$TOKEN" ]; then
        log "Login failed. Response: $RESP"
        return 1
    fi
    echo "$TOKEN"
}

# --- Step 2: Get or create storage ---
get_storage() {
    local TOKEN="$1"
    log "Finding storage '$STORAGE_NAME'..."
    RESP=$(curl -s --max-time 30 "$PENTARACT_URL/api/storages" -H "Authorization: Bearer $TOKEN")
    STORAGE_ID=$(echo "$RESP" | node -e "
        let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            try{
                const storages=JSON.parse(d);
                const s=storages.find(s=>s.name===process.env.SNAME);
                console.log(s?s.id:'');
            }catch(e){ console.log(''); }
        });
    " 2>/dev/null || echo "")

    if [ -z "$STORAGE_ID" ]; then
        log "Storage '$STORAGE_NAME' not found, creating..."
        CHAT_ID="${TELEGRAM_CHANNEL_ID:--1002457940351}"
        RESP=$(curl -s --max-time 30 -X POST "$PENTARACT_URL/api/storages" \
            -H "Authorization: Bearer $TOKEN" \
            -d "name=$STORAGE_NAME" \
            -d "chat_id=$CHAT_ID")
        STORAGE_ID=$(echo "$RESP" | node -e "
            let d='';
            process.stdin.on('data',c=>d+=c);
            process.stdin.on('end',()=>{
                try{ const j=JSON.parse(d); console.log(j.id||''); }catch(e){ console.log(''); }
            });
        ")
        if [ -z "$STORAGE_ID" ]; then
            log "Could not create storage. Response: $RESP"
            return 1
        fi
        log "Storage created: $STORAGE_ID"
    else
        log "Storage found: $STORAGE_ID"
    fi
    echo "$STORAGE_ID"
}

# --- Step 3: Create and upload backup ---
do_backup() {
    local STORAGE_ID="$1"
    local TOKEN="$2"

    TIMESTAMP=$(date -u +%Y-%m-%dT%H-%M-%S)
    BACKUP_FILE="/tmp/kimi-backup-$TIMESTAMP.tar.gz"

    log "Creating backup archive..."
    tar czf "$BACKUP_FILE" \
        --exclude='.kimi-code/bin' \
        --exclude='.kimi-code/skills' \
        --exclude='.kimi-code/scripts' \
        --exclude='.kimi-code/signup-app' \
        --exclude='.kimi-code/server/lock' \
        --exclude='*.log' \
        --exclude='node_modules' \
        --exclude='**/wire.jsonl' \
        -C "$KIMI_HOME" \
        .kimi-code 2>/dev/null || true

    SIZE=$(stat -c%s "$BACKUP_FILE" 2>/dev/null || echo 0)
    if [ "$SIZE" -lt 50 ]; then
        log "Backup too small ($SIZE bytes), creating minimal backup..."
        tar czf "$BACKUP_FILE" \
            -C "$KIMI_HOME" \
            .kimi-code/config.toml \
            .kimi-code/device_id \
            .kimi-code/server.token \
            2>/dev/null || true
        SIZE=$(stat -c%s "$BACKUP_FILE" 2>/dev/null || echo 0)
    fi
    log "Backup size: $SIZE bytes"

    log "Uploading to Pentaract (timeout: ${UPLOAD_TIMEOUT}s)..."
    RESP=""
    for attempt in 1 2 3; do
        RESP=$(curl -s --max-time "$UPLOAD_TIMEOUT" -X POST \
            "$PENTARACT_URL/api/files/$STORAGE_ID/upload" \
            -H "Authorization: Bearer $TOKEN" \
            -F "file=@$BACKUP_FILE" \
            -F "path=/backups/")
        if [ -n "$RESP" ]; then
            FILE_ID=$(echo "$RESP" | node -e "
                let d='';
                process.stdin.on('data',c=>d+=c);
                process.stdin.on('end',()=>{
                    try{ const j=JSON.parse(d); console.log(j.id||j.path||'unknown'); }catch(e){ console.log('parse_error'); }
                });
            ")
            if [ "$FILE_ID" != "parse_error" ] && [ -n "$FILE_ID" ] && [ "$FILE_ID" != "unknown" ]; then
                break
            fi
        fi
        log "Upload attempt $attempt failed, retrying..."
        sleep 5
        FILE_ID=""
    done
    if [ -z "$FILE_ID" ]; then
        log "Upload failed after 3 attempts. Response: $RESP"
    else
        log "Backup uploaded: $FILE_ID"
    fi
    rm -f "$BACKUP_FILE"
}

# --- Main ---
main() {
    log "Starting backup..."
    TOKEN=$(login) || exit 1
    STORAGE_ID=$(get_storage "$TOKEN") || exit 1
    do_backup "$STORAGE_ID" "$TOKEN"
    log "Backup complete."
}

main
