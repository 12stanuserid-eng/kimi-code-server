# Pentaract - Test: Python minimal server
FROM python:3.14-slim

WORKDIR /app

# Just install core deps first
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 10000
ENTRYPOINT ["/bin/bash", "/entrypoint.sh"]
