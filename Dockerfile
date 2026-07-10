# Use the official pre-built omniroute image
FROM diegosouzapw/omniroute:latest

# Override env vars to reduce memory for Render free plan
ENV OMNIROUTE_MEMORY_MB=384
ENV NODE_OPTIONS="--max-old-space-size=384"
ENV PORT=10000
ENV HOSTNAME=0.0.0.0

EXPOSE 10000
