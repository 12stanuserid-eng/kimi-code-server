#!/bin/bash
# Entrypoint: start pentaract — skip local PostgreSQL when using external DB
exec > /tmp/entrypoint.log 2>&1
set -x

echo "[entrypoint] Starting up at $(date)"

# Determine if we should use external DB or start local PostgreSQL
USE_EXTERNAL_DB=false
if [ -n "$DATABASE_URL" ]; then
    USE_EXTERNAL_DB=true
elif [ -n "$DATABASE_HOST" ] && [ "$DATABASE_HOST" != "localhost" ] && [ "$DATABASE_HOST" != "127.0.0.1" ]; then
    USE_EXTERNAL_DB=true
fi

if [ "$USE_EXTERNAL_DB" = true ]; then
    echo "[entrypoint] External database detected — skipping local PostgreSQL"
    echo "[entrypoint] DATABASE_URL: ${DATABASE_URL:+set}"
    echo "[entrypoint] DATABASE_HOST: ${DATABASE_HOST:-localhost}"
    echo "[entrypoint] DATABASE_PORT: ${DATABASE_PORT:-5432}"

    # Test DNS resolution
    echo "[entrypoint] Testing DNS resolution..."
    hostname=$(echo "${DATABASE_HOST:-db.iakqmubdnmoqimnlifms.supabase.co}" | head -1)
    if command -v host >/dev/null 2>&1; then
        host "$hostname" 2>&1 || echo "host command failed"
    elif command -v nslookup >/dev/null 2>&1; then
        nslookup "$hostname" 2>&1 || echo "nslookup failed"
    elif command -v getent >/dev/null 2>&1; then
        getent hosts "$hostname" 2>&1 || echo "getent failed"
    else
        echo "No DNS lookup tool available"
    fi

    # Test TCP connectivity
    echo "[entrypoint] Testing TCP connectivity to ${hostname}:${DATABASE_PORT:-5432}..."
    timeout 5 bash -c "echo > /dev/tcp/${hostname}/${DATABASE_PORT:-5432}" 2>&1 &&
        echo "TCP OK" || echo "TCP FAILED (expected if /dev/tcp not available)"

    # Test psql connectivity
    echo "[entrypoint] Testing psql connection..."
    if command -v psql >/dev/null 2>&1; then
        if [ -n "$DATABASE_URL" ]; then
            PGPASSWORD="${DATABASE_PASSWORD:-}" timeout 10 psql "$DATABASE_URL" -c "SELECT 1 AS connected;" 2>&1 ||
                echo "psql connection test failed (expected if binary will also fail)"
        fi
    else
        echo "psql not available"
    fi
    echo "[entrypoint] Diagnostic complete."
else
    echo "[entrypoint] No external database — starting bundled PostgreSQL"

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
fi

echo "[entrypoint] Starting pentaract..."
date
exec /pentaract
