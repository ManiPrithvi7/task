# =============================================================================
# Combined Mosquitto + Node.js statsmqtt image for Fly.io
# Runs both the MQTT broker and the application server in a single container.
# =============================================================================

# --- Stage 1: Build TypeScript ---
FROM node:18-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# --- Stage 2: Production ---
FROM node:18-alpine

RUN apk add --no-cache mosquitto openssl dumb-init

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production && \
    npm cache clean --force && \
    rm -rf /tmp/* /var/cache/apk/*

COPY --from=builder /app/dist ./dist
COPY public ./public

COPY deploy/fly/mosquitto.conf /mosquitto/config/mosquitto.conf
COPY deploy/fly/start.sh /start.sh
RUN chmod +x /start.sh

RUN mkdir -p /data/ca /data/mosquitto /mosquitto/log

EXPOSE 8883 3002

ENTRYPOINT ["dumb-init", "--"]
CMD ["/start.sh"]
