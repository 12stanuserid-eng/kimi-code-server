#!/bin/bash
# Entrypoint: start pentaract with local PostgreSQL + periodic Supabase backup
exec > /tmp/entrypoint.log 2>&1
set -x

echo "[entrypoint] Starting up at $(date)"

# ============================================================
# Step 1: Start bundled PostgreSQL (ALWAYS)
# ============================================================
echo "[entrypoint] Starting bundled PostgreSQL..."
pg_dropcluster --stop 15 main 2>/dev/null || true
pg_createcluster --start 15 main 2>&1 || {
    echo "[entrypoint] pg_createcluster failed, trying raw initdb..."
    PGDATA=/var/lib/postgresql/15/main
    mkdir -p "$PGDATA" /var/run/postgresql
    chown -R postgres:postgres /var/lib/postgresql /var/run/postgresql
    su - postgres -c "/usr/lib/postgresql/15/bin/initdb -D $PGDATA"

    echo "host all all 127.0.0.1/32 md5" >> "$PGDATA/pg_hba.conf"
    echo "host all all ::1/128 md5" >> "$PGDATA/pg_hba.conf"
    echo "local all all trust" >> "$PGDATA/pg_hba.conf"

    cat >> "$PGDATA/postgresql.conf" << 'EOF'
listen_addresses = 'localhost'
port = 5432
max_connections = 10
shared_buffers = 16MB
wal_level = minimal
fsync = off
synchronous_commit = off
EOF
    su - postgres -c "/usr/lib/postgresql/15/bin/pg_ctl -D $PGDATA -l /tmp/pg.log start"
}

for i in $(seq 1 30); do
    if su - postgres -c "pg_isready -q" 2>/dev/null; then
        echo "[entrypoint] PostgreSQL ready after ${i}s"
        break
    fi
    sleep 1
done

su - postgres -c "pg_isready" 2>&1 || {
    echo "[entrypoint] PostgreSQL failed to become ready!"
    cat /tmp/pg.log 2>/dev/null || true
    pg_lsclusters 2>/dev/null || true
    exit 1
}

PG_HBA=$(find /etc/postgresql -name pg_hba.conf 2>/dev/null | head -1)
if [ -n "$PG_HBA" ]; then
    echo "host all all 127.0.0.1/32 md5" >> "$PG_HBA"
    echo "host all all ::1/128 md5" >> "$PG_HBA"
    pg_ctlcluster 15 main reload || true
fi

echo "[entrypoint] Setting up database..."
su - postgres -c "psql -c \"CREATE USER pentaract WITH LOGIN PASSWORD 'pentaract';\"" 2>&1 || true
su - postgres -c "psql -c \"CREATE DATABASE pentaract OWNER pentaract;\"" 2>&1 || true
echo "[entrypoint] PostgreSQL setup complete."

# ============================================================
# Step 2: Restore from Supabase if available and DB is empty
# ============================================================
SUPABASE_URL="${DATABASE_URL:-}"
if [ -n "$SUPABASE_URL" ]; then
    echo "[entrypoint] Supabase backup URL detected — attempting restore..."

    # Check if local DB has any tables
    TABLE_COUNT=$(su - postgres -c "psql -d pentaract -t -A -c \"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';\"" 2>/dev/null || echo "0")

    if [ "$TABLE_COUNT" = "0" ] || [ -z "$TABLE_COUNT" ]; then
        echo "[entrypoint] Local DB empty — attempting restore from Supabase (timeout 15s)..."
        timeout 15 sh -c "PGPASSWORD=\"${DATABASE_PASSWORD:-}\" pg_dump \"$SUPABASE_URL\" --no-owner --no-privileges 2>/tmp/pg_dump_err.log | su - postgres -c 'psql -d pentaract' 2>/tmp/pg_restore_err.log" && \
            echo "[entrypoint] Restore from Supabase successful." || {
            echo "[entrypoint] Restore from Supabase failed or timed out (non-critical, continuing)"
            cat /tmp/pg_dump_err.log 2>/dev/null || true
        }
    else
        echo "[entrypoint] Local DB has $TABLE_COUNT tables — skipping restore."
    fi
else
    echo "[entrypoint] No Supabase URL — skipping backup/restore."
fi

# ============================================================
# Step 3: Set local DATABASE_URL for Pentaract binary
# ============================================================
export DATABASE_URL="postgres://pentaract:pentaract@localhost:5432/pentaract?sslmode=disable"
export DATABASE_HOST="localhost"
export DATABASE_PORT="5432"
export DATABASE_USER="pentaract"
export DATABASE_PASSWORD="pentaract"
export DATABASE_NAME="pentaract"
export DATABASE_SSL_MODE="disable"

echo "[entrypoint] Using local PostgreSQL"
echo "[entrypoint] DATABASE_URL: postgres://pentaract:****@localhost:5432/pentaract?sslmode=disable"

# ============================================================
# Step 4: Start background backup cron to Supabase (if URL set)
# ============================================================
if [ -n "$SUPABASE_URL" ]; then
    echo "[entrypoint] Starting background backup to Supabase (every 10 min)..."
    cat > /tmp/backup.sh << 'BACKUPEOF'
#!/bin/bash
SUPABASE_URL="$1"
while true; do
    echo "[backup] Running pg_dump at $(date)"
    timeout 30 pg_dump -U pentaract -h localhost pentaract --no-owner --no-privileges 2>/tmp/backup_err.log | \
        timeout 30 psql "$SUPABASE_URL" 2>/tmp/backup_apply_err.log && \
        echo "[backup] Backup to Supabase successful at $(date)" || \
        echo "[backup] Backup to Supabase failed at $(date) — may be transient"
    sleep 600
done
BACKUPEOF
    chmod +x /tmp/backup.sh
    SUPABASE_URL="$SUPABASE_URL" nohup bash /tmp/backup.sh "$SUPABASE_URL" > /tmp/backup_daemon.log 2>&1 &
    echo "[entrypoint] Backup daemon started (PID $!)"
fi

# ============================================================
# Step 5: Start Pentaract
# ============================================================
echo "[entrypoint] Starting pentaract..."
date
exec /pentaract
