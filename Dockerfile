# Pentaract - Minimal test build
FROM python:3.11-slim
WORKDIR /app
RUN python3 -c "print('BUILD OK: python image works')"
CMD ["python3", "-m", "http.server", "10000"]
