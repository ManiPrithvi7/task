# Bun 1.3+ required: bun.lock (lockfileVersion 1) is rejected by Bun 1.1.x
FROM oven/bun:1.3.12-alpine AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3.12-alpine
RUN apk add --no-cache dumb-init
RUN addgroup -g 1001 -S bunjs && adduser -S bunjs -u 1001
WORKDIR /app
# Writable runtime dirs (non-root bunjs cannot mkdir under /app/src)
RUN mkdir -p /app/data/certs && chown -R bunjs:bunjs /app/data
COPY --from=builder --chown=bunjs:bunjs /app/dist ./dist
COPY --from=builder --chown=bunjs:bunjs /app/node_modules ./node_modules
COPY --from=builder --chown=bunjs:bunjs /app/package.json ./
USER bunjs
ENV NODE_ENV=production \
    PORT=3002 \
    DATA_DIR=/app/data \
    PROVISIONING_CA_DIR=/app/data/certs \
    CA_STORAGE_PATH=/app/data/certs
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3002)+'/health').then(r => r.ok ? process.exit(0) : process.exit(1))"
ENTRYPOINT ["dumb-init", "--"]
CMD ["bun", "run", "./dist/index.js"]
