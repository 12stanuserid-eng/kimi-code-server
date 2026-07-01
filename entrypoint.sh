#!/bin/bash
# Entrypoint: starts PostgreSQL, then pentaract
exec > /tmp/entrypoint.log 2>&1
set -x

echo "[entrypoint] Starting up..."
date

PGDATA=/var/lib/postgresql/15/main

# Check if postgres user exists, if not create it
if ! id -u postgres &>/dev/null; then
    echo "[entrypoint] Creating postgres user..."
    groupadd -r postgres 2>/dev/null
    useradd -r -g postgres -d /var/lib/postgresql -s /bin/bash postgres 2>/dev/null
fi

# Create necessary directories
mkdir -p "$PGDATA" /var/run/postgresql
chown -R postgres:postgres /var/lib/postgresql /var/run/postgresql
chmod 700 "$PGDATA"

# Initialize database if needed (in case apt didn't do it)
if [ ! -f "$PGDATA/PG_VERSION" ]; then
    echo "[entrypoint] Running initdb..."
    su - postgres -c "/usr/lib/postgresql/15/bin/initdb -D $PGDATA"
    RC=$?
    if [ $RC -ne 0 ]; then
        echo "[entrypoint] initdb failed with code $RC"
        # Check if cluster already exists
        /usr/lib/postgresql/15/bin/pg_lsclusters 2>/dev/null || true
        exit 1
    fi
fi

# Ensure pg_hba.conf allows local TCP connections with password
echo "host all all 127.0.0.1/32 md5" >> "$PGDATA/pg_hba.conf"
echo "host all all ::1/128 md5" >> "$PGDATA/pg_hba.conf"
echo "local all all trust" >> "$PGDATA/pg_hba.conf"

# Set minimal PG config
cat >> "$PGDATA/postgresql.conf" << 'EOF'
listen_addresses = 'localhost'
port = 5432
max_connections = 10
shared_buffers = 16MB
work_mem = 2MB
wal_level = minimal
fsync = off
synchronous_commit = off
full_page_writes = off
min_wal_size = 32MB
max_wal_size = 64MB
EOF

# Start PostgreSQL
echo "[entrypoint] Starting PostgreSQL..."
su - postgres -c "/usr/lib/postgresql/15/bin/pg_ctl -D $PGDATA -l /tmp/pg.log start"
RC=$?
if [ $RC -ne 0 ]; then
    echo "[entrypoint] pg_ctl failed with code $RC"
    /usr/lib/postgresql/15/bin/pg_ctl -D "$PGDATA" status 2>&1 || true
    cat /tmp/pg.log 2>/dev/null
    ls -la "$PGDATA" | head -10
    exit 1
fi

# Wait for PostgreSQL
echo "[entrypoint] Waiting for PostgreSQL..."
for i in $(seq 1 30); do
    if su - postgres -c "/usr/lib/postgresql/15/bin/pg_isready -q" 2>/dev/null; then
        echo "[entrypoint] PostgreSQL ready after ${i}s"
        break
    fi
    sleep 1
done

# Final check
echo "[entrypoint] Checking PostgreSQL status..."
su - postgres -c "/usr/lib/postgresql/15/bin/pg_isready" 2>&1 || {
    echo "[entrypoint] PostgreSQL failed to become ready"
    cat /tmp/pg.log 2>/dev/null
    exit 1
}

# Create database user if needed
echo "[entrypoint] Setting up database..."
su - postgres -c "/usr/lib/postgresql/15/bin/psql -c \"CREATE USER pentaract WITH LOGIN PASSWORD 'pentaract';\"" 2>&1 || true
su - postgres -c "/usr/lib/postgresql/15/bin/psql -c \"CREATE DATABASE pentaract OWNER pentaract;\"" 2>&1 || true

echo "[entrypoint] PostgreSQL setup complete."
echo "[entrypoint] Starting pentaract..."
date

exec /pentaract
