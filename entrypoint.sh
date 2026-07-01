#!/bin/bash
set -euo pipefail

echo "[entrypoint] Starting bundled PostgreSQL..."

PGDATA=/var/lib/postgresql/15/main

# Create postgres user if missing
if ! id -u postgres &>/dev/null; then
    groupadd -r postgres
    useradd -r -g postgres -s /bin/bash -d /var/lib/postgresql postgres
fi

# Ensure data directory exists
mkdir -p "$PGDATA" /var/run/postgresql /tmp/pg
chown -R postgres:postgres /var/lib/postgresql /var/run/postgresql /tmp/pg
chmod 700 "$PGDATA"

# Initialize DB if needed
if [ ! -f "$PGDATA/PG_VERSION" ]; then
    echo "[entrypoint] Running initdb..."
    su - postgres -c "/usr/lib/postgresql/15/bin/initdb -D $PGDATA -E utf8 --locale=C.UTF-8" 2>&1
fi

# Write minimal pg config
cat >> "$PGDATA/postgresql.conf" <<'CONF'
listen_addresses = 'localhost'
port = 5432
max_connections = 20
shared_buffers = 32MB
work_mem = 4MB
maintenance_work_mem = 16MB
effective_cache_size = 128MB
wal_buffers = 1MB
min_wal_size = 64MB
max_wal_size = 256MB
log_statement = 'none'
CONF

# Start PG
echo "[entrypoint] Starting PostgreSQL server..."
su - postgres -c "/usr/lib/postgresql/15/bin/pg_ctl -D $PGDATA -l /tmp/pg/pg.log start" 2>&1

# Wait for PG to be ready
echo "[entrypoint] Waiting for PostgreSQL..."
for i in $(seq 1 30); do
    if su - postgres -c "/usr/lib/postgresql/15/bin/pg_isready -q" 2>/dev/null; then
        echo "[entrypoint] PostgreSQL is ready (attempt $i)"
        break
    fi
    echo "[entrypoint] Waiting... ($i/30)"
    sleep 1
done

# Verify PG is actually running
if ! su - postgres -c "/usr/lib/postgresql/15/bin/pg_isready" 2>/dev/null; then
    echo "[entrypoint] FATAL: PostgreSQL failed to start. Logs:"
    cat /tmp/pg/pg.log 2>/dev/null || true
    exit 1
fi

# Create database and user
echo "[entrypoint] Setting up database..."
su - postgres -c "/usr/lib/postgresql/15/bin/psql -c \"
    DO \$\$
    BEGIN
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'pentaract') THEN
            CREATE ROLE pentaract WITH LOGIN PASSWORD 'pentaract';
        END IF;
    END
    \$\$;\"" 2>&1

su - postgres -c "/usr/lib/postgresql/15/bin/psql -c \"
    SELECT 'CREATE DATABASE pentaract OWNER pentaract'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'pentaract');\"" 2>&1

echo "[entrypoint] PostgreSQL setup complete."
echo "[entrypoint] Starting pentaract..."

exec /pentaract
