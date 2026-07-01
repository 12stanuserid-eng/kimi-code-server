#!/bin/bash
echo "[entrypoint] Starting..."

PGDATA=/var/lib/postgresql/15/main

# Create postgres user if missing
if ! id -u postgres &>/dev/null; then
    groupadd -r postgres 2>/dev/null
    useradd -r -g postgres -d /var/lib/postgresql postgres 2>/dev/null
fi

# Ensure directories
mkdir -p "$PGDATA" /var/run/postgresql
chown -R postgres:postgres /var/lib/postgresql /var/run/postgresql
chmod 700 "$PGDATA"

# Init DB if fresh
if [ ! -f "$PGDATA/PG_VERSION" ]; then
    echo "[entrypoint] Running initdb..."
    su - postgres -c "/usr/lib/postgresql/15/bin/initdb -D $PGDATA" || {
        echo "[entrypoint] initdb failed"
        exit 1
    }
fi

# Tune PG config
{
    echo "listen_addresses = 'localhost'"
    echo "port = 5432"
    echo "max_connections = 10"
    echo "shared_buffers = 16MB"
    echo "work_mem = 2MB"
    echo "wal_level = minimal"
    echo "fsync = off"
    echo "synchronous_commit = off"
    echo "full_page_writes = off"
    echo "min_wal_size = 32MB"
    echo "max_wal_size = 64MB"
} >> "$PGDATA/postgresql.conf"

# Start PG
echo "[entrypoint] Starting PostgreSQL..."
su - postgres -c "/usr/lib/postgresql/15/bin/pg_ctl -D $PGDATA -l /tmp/pg.log start" || {
    echo "[entrypoint] pg_ctl start failed"
    cat /tmp/pg.log 2>/dev/null
    exit 1
}

# Wait for PG
echo "[entrypoint] Waiting for PostgreSQL..."
for i in $(seq 1 15); do
    if su - postgres -c "/usr/lib/postgresql/15/bin/pg_isready -q" 2>/dev/null; then
        echo "[entrypoint] PostgreSQL ready"
        break
    fi
    sleep 1
done

# Verify
su - postgres -c "/usr/lib/postgresql/15/bin/pg_isready" || {
    echo "[entrypoint] PostgreSQL not reachable"
    cat /tmp/pg.log 2>/dev/null
    exit 1
}

# Create user and database
echo "[entrypoint] Creating user and database..."
su - postgres -c "/usr/lib/postgresql/15/bin/psql -c \"CREATE USER pentaract WITH LOGIN PASSWORD 'pentaract';\" 2>/dev/null; echo OK" 2>&1
su - postgres -c "/usr/lib/postgresql/15/bin/createdb -O pentaract pentaract 2>/dev/null; echo OK" 2>&1

echo "[entrypoint] Setup complete. Starting pentaract..."
exec /pentaract
