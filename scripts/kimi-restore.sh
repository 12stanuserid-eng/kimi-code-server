#!/bin/bash
# kimi-restore.sh - Restore ~/.kimi-code/ from Pentaract Telegram storage
set -e

PENTARACT_URL="${PENTARACT_URL:-https://pentaract-f4ga.onrender.com}"
PENTARACT_EMAIL="${PENTARACT_EMAIL:-admin@pentaract.com}"
PENTARACT_PASS="${PENTARACT_PASS:-admin123}"
STORAGE_NAME="${STORAGE_NAME:-kimi-backup}"
KIMI_HOME="${KIMI_HOME:-/root}"

log() { echo "[restore] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# --- Step 1: Login ---
login() {
    log "Logging in..."
    RESP=$(curl -s -X POST "$PENTARACT_URL/api/auth/login" \
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
        log "Login failed (first run? no backup yet?)"
        return 1
    fi
    echo "$TOKEN"
}

# --- Step 2: Find storage ---
get_storage() {
    local TOKEN="$1"
    RESP=$(curl -s "$PENTARACT_URL/api/storages" -H "Authorization: Bearer $TOKEN")
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
        log "Storage '$STORAGE_NAME' not found"
        return 1
    fi
    echo "$STORAGE_ID"
}

# --- Step 3: Find latest backup ---
find_latest_backup() {
    local STORAGE_ID="$1"
    local TOKEN="$2"
    
    RESP=$(curl -s "$PENTARACT_URL/api/files/$STORAGE_ID/tree" -H "Authorization: Bearer $TOKEN")
    LATEST=$(echo "$RESP" | node -e "
        let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            try{
                const data=JSON.parse(d);
                const files=data.files||[];
                const backups=files.filter(f=>f.path.startsWith('backups/kimi-backup-') && f.is_uploaded);
                if(backups.length===0){ console.log(''); return; }
                backups.sort((a,b)=>a.path.localeCompare(b.path));
                console.log(backups[backups.length-1].path);
            }catch(e){ console.log(''); }
        });
    " 2>/dev/null || echo "")
    echo "$LATEST"
}

# --- Step 4: Download and restore ---
restore_backup() {
    local STORAGE_ID="$1"
    local TOKEN="$2"
    local BACKUP_PATH="$3"
    
    log "Downloading $BACKUP_PATH..."
    curl -s "$PENTARACT_URL/api/files/$STORAGE_ID/download/$BACKUP_PATH" \
        -H "Authorization: Bearer $TOKEN" \
        -o /tmp/restore.tar.gz
    
    if [ ! -f /tmp/restore.tar.gz ] || [ $(stat -c%s /tmp/restore.tar.gz 2>/dev/null || echo 0) -lt 10 ]; then
        log "Backup download failed or empty"
        rm -f /tmp/restore.tar.gz
        return 1
    fi
    
    log "Extracting to $KIMI_HOME..."
    tar xzf /tmp/restore.tar.gz -C "$KIMI_HOME" 2>/dev/null || true
    rm -f /tmp/restore.tar.gz
    log "Restore complete"
    return 0
}

# --- Main ---
main() {
    log "Starting restore check..."
    
    # Don't restore if data already exists and is recent
    if [ -f "$KIMI_HOME/.kimi-code/session_index.jsonl" ]; then
        SESSION_COUNT=$(wc -l < "$KIMI_HOME/.kimi-code/session_index.jsonl" 2>/dev/null || echo 0)
        log "Kimi data already exists ($SESSION_COUNT sessions) — skipping restore"
        exit 0
    fi
    
    TOKEN=$(login) || exit 0
    STORAGE_ID=$(get_storage "$TOKEN") || exit 0
    BACKUP_PATH=$(find_latest_backup "$STORAGE_ID" "$TOKEN")
    
    if [ -z "$BACKUP_PATH" ]; then
        log "No backups found in storage"
        exit 0
    fi
    
    restore_backup "$STORAGE_ID" "$TOKEN" "$BACKUP_PATH"
}

main
