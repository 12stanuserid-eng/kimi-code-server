FROM node:20-slim

WORKDIR /app

COPY package.json ./

# Install dependencies (better-sqlite3 needs native compilation so we need full install)
RUN npm install --no-audit --no-fund

# Set runtime env vars for Render
ENV NODE_ENV=production
ENV PORT=10000
ENV HOSTNAME=0.0.0.0
ENV OMNIROUTE_MEMORY_MB=384

EXPOSE 10000

# Use node directly to run the local omniroute binary
CMD ["node", "./node_modules/.bin/omniroute", "serve", "--port", "10000"]
