#!/bin/bash
# Entrypoint: just exec pentaract — it reads DATABASE_URL env var for Supabase
exec > /tmp/entrypoint.log 2>&1
set -x
echo "[entrypoint] Starting pentaract directly (Supabase mode)..."
date
exec /pentaract
