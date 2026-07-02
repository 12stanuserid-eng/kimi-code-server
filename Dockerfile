# Pentaract - Python FastAPI service with Telegram unlimited storage
FROM python:3.14-slim AS runtime

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the server code
COPY server.py .

# Copy UI (if built)
RUN mkdir -p ui
COPY ui/dist ui/dist 2>/dev/null || echo "[build] No UI dist found, API-only mode"

# Copy entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 10000
ENTRYPOINT ["/bin/bash", "/entrypoint.sh"]
