#!/bin/bash
# Entrypoint: start pentaract — if DATABASE_URL is set, skip local PostgreSQL
exec > /tmp/entrypoint.log 2>&1
set -x

echo "[entrypoint] Starting up at $(date)"

if [ -n "$DATABASE_URL" ]; then
    echo "[entrypoint] DATABASE_URL is set — skipping local PostgreSQL, connecting to external DB"
    echo "[entrypoint] DATABASE_URL prefix: $(echo "$DATABASE_URL" | cut -d'@' -f2 | cut -d'/' -f1)"
else
    echo "[entrypoint] No DATABASE_URL — starting bundled PostgreSQL"

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
