#!/bin/bash
set -e

# PostgreSQL setup for Render free tier (ephemeral storage)
PG_VERSION=15
PG_DATA=/var/lib/postgresql/$PG_VERSION/main
PG_BIN=/usr/lib/postgresql/$PG_VERSION/bin
PG_CONF=/etc/postgresql/$PG_VERSION/main/postgresql.conf

echo "[entrypoint] Initializing PostgreSQL $PG_VERSION..."

# Create postgres user if not exists
if ! id postgres &>/dev/null; then
    echo "[entrypoint] Creating postgres user..."
    useradd -r -s /bin/false postgres
fi

# Initialize PG data directory if needed
if [ ! -f "$PG_DATA/PG_VERSION" ]; then
    echo "[entrypoint] Initializing PG data directory..."
    mkdir -p "$PG_DATA"
    chown -R postgres:postgres "$PG_DATA"
    chmod 700 "$PG_DATA"
    su - postgres -c "$PG_BIN/initdb -D $PG_DATA -E utf8 --locale=C.UTF-8"
fi

# Configure PostgreSQL for low-memory environment
echo "[entrypoint] Configuring PostgreSQL for minimal memory usage..."
su - postgres -c "echo 'listen_addresses = localhost' >> $PG_DATA/postgresql.conf"
su - postgres -c "echo 'port = 5432' >> $PG_DATA/postgresql.conf"
su - postgres -c "echo 'shared_buffers = 32MB' >> $PG_DATA/postgresql.conf"
su - postgres -c "echo 'effective_cache_size = 128MB' >> $PG_DATA/postgresql.conf"
su - postgres -c "echo 'maintenance_work_mem = 16MB' >> $PG_DATA/postgresql.conf"
su - postgres -c "echo 'checkpoint_completion_target = 0.5' >> $PG_DATA/postgresql.conf"
su - postgres -c "echo 'wal_buffers = 1MB' >> $PG_DATA/postgresql.conf"
su - postgres -c "echo 'default_statistics_target = 100' >> $PG_DATA/postgresql.conf"
su - postgres -c "echo 'random_page_cost = 1.1' >> $PG_DATA/postgresql.conf"
su - postgres -c "echo 'effective_io_concurrency = 200' >> $PG_DATA/postgresql.conf"
su - postgres -c "echo 'work_mem = 4MB' >> $PG_DATA/postgresql.conf"
su - postgres -c "echo 'min_wal_size = 64MB' >> $PG_DATA/postgresql.conf"
su - postgres -c "echo 'max_wal_size = 256MB' >> $PG_DATA/postgresql.conf"
su - postgres -c "echo 'max_connections = 20' >> $PG_DATA/postgresql.conf"

# Start PostgreSQL
echo "[entrypoint] Starting PostgreSQL..."
su - postgres -c "$PG_BIN/pg_ctl -D $PG_DATA -l /tmp/pg.log start"

# Wait for PostgreSQL to be ready
echo "[entrypoint] Waiting for PostgreSQL to be ready..."
for i in $(seq 1 30); do
    if su - postgres -c "$PG_BIN/pg_isready -q" 2>/dev/null; then
        echo "[entrypoint] PostgreSQL is ready!"
        break
    fi
    echo "[entrypoint] Waiting... ($i/30)"
    sleep 1
done

# Create pentaract user and database if not exists
echo "[entrypoint] Setting up pentaract database..."
su - postgres -c "$PG_BIN/psql -c \"SELECT 1 FROM pg_roles WHERE rolname='pentaract';\"" 2>/dev/null | grep -q 1 || \
    su - postgres -c "$PG_BIN/psql -c \"CREATE USER pentaract WITH PASSWORD 'pentaract';\"" 2>/dev/null

su - postgres -c "$PG_BIN/psql -c \"SELECT 1 FROM pg_database WHERE datname='pentaract';\"" 2>/dev/null | grep -q 1 || \
    su - postgres -c "$PG_BIN/psql -c \"CREATE DATABASE pentaract OWNER pentaract;\"" 2>/dev/null

echo "[entrypoint] PostgreSQL setup complete!"

# Start pentaract
echo "[entrypoint] Starting pentaract..."
exec /pentaract
