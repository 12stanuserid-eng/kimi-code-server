FROM node:20-alpine

RUN apk add --no-cache git && \
    npm install -g omniroute@3.8.46

ENV PORT=10000
EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:10000/api/monitoring/health || exit 1

CMD ["omniroute", "serve"]
