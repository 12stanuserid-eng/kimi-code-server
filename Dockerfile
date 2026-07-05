# Pentaract - Test: Python minimal server
FROM python:3.12-slim

WORKDIR /app

# Install build dependencies for cryptography and other packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libffi-dev \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Upgrade pip and install deps with longer timeout for Render builds
COPY requirements.txt .
RUN pip install --upgrade pip && \
    pip install --default-timeout=120 --no-cache-dir -r requirements.txt

COPY server.py .
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 10000
ENTRYPOINT ["/bin/bash", "/entrypoint.sh"]
