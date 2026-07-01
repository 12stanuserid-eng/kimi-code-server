#!/bin/bash
# Entrypoint: just start pentaract (PostgreSQL is external on Supabase)
exec > /tmp/entrypoint.log 2>&1
set -x

echo "[entrypoint] Starting pentaract with external Supabase PostgreSQL..."
date

exec /pentaract
