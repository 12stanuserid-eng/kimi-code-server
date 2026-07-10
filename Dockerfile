# Use the official pre-built omniroute image
FROM diegosouzapw/omniroute:latest

# Override env vars to reduce memory for Render free plan
ENV OMNIROUTE_MEMORY_MB=384
ENV NODE_OPTIONS="--max-old-space-size=384"
ENV PORT=10000
ENV HOSTNAME=0.0.0.0
ENV API_PORT=10000
ENV DASHBOARD_PORT=10000

# Remove the built-in healthcheck that might check wrong port
HEALTHCHECK NONE

EXPOSE 10000
