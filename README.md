# MQTT Publisher Lite

**Industrial-Grade MQTT Publisher with PKI Device Provisioning**

A production-ready MQTT publisher server for IoT device fleet management. Handles device registration, certificate provisioning (mTLS), real-time stats publishing, and secure communication over EMQX Cloud broker.

## Features

- **mTLS Device Provisioning** — Full PKI lifecycle: onboarding, CSR signing, certificate issuance/renewal/revocation
- **Industrial-Grade PKI** — Structured CN format, certificate chain validation, hash-chained audit trail, runtime KU/EKU enforcement
- **Real-Time Stats Publishing** — Instagram, GMB, POS, and Promotion screen data pushed to devices via MQTT QoS 1
- **Redis-Backed Active Device Cache** — Zero-latency device enumeration during publish cycles (no per-cycle MongoDB queries)
- **InfluxDB Time-Series Storage** — PKI audit events, rate limit metrics, certificate transparency logs
- **Tiered Rate Limiting** — Global, provisioning, and CSR-specific rate limits with Redis persistence
- **Certificate Transparency Log** — Internal Merkle tree with inclusion proofs for every issued certificate
- **WebSocket Support** — Real-time MQTT message streaming to web clients
- **Kafka Event Streaming** — Cross-domain event publishing via HTTP bridge; external apps can push events to Kafka topics over port 9092
- **Cloud-Ready** — Deployed on Render.com with EMQX Cloud broker

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  MQTT Publisher Lite                                         │
│                                                              │
│  ┌────────────────────────────────┐   ┌───────────────────┐ │
│  │  HTTP API (Express)            │   │  MQTT Client      │ │
│  │  ├─ /health                    │   │  → EMQX Cloud     │ │
│  │  ├─ /api/devices               │   │  → TLS / mTLS     │ │
│  │  ├─ /api/publish               │   │  → QoS 1 tracking │ │
│  │  ├─ /api/v1/onboarding        │   └───────────────────┘ │
│  │  ├─ /api/v1/sign-csr          │                          │
│  │  ├─ /api/v1/certificates/*    │   ┌───────────────────┐ │
│  │  └─ /api/v1/mqtt-config       │   │  WebSocket /ws    │ │
│  └────────────────────────────────┘   └───────────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Services                                              │ │
│  │  ├─ CAService         (Root CA, CSR signing)           │ │
│  │  ├─ AuditService      (SHA-256 hash chain → InfluxDB)  │ │
│  │  ├─ TransparencyLog   (Merkle tree → InfluxDB)         │ │
│  │  ├─ StatsPublisher    (Instagram/GMB/POS/Promotion)    │ │
│  │  ├─ DeviceService     (MongoDB CRUD + Redis cache)     │ │
│  │  ├─ KafkaService      (Event producer → Kafka broker)  │ │
│  │  └─ ChainValidator    (RFC 5280 cert chain validation) │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────────┐│
│  │  MongoDB   │  │   Redis    │  │  InfluxDB              ││
│  │  (primary) │  │  (cache +  │  │  (audit + transparency ││
│  │            │  │   tokens)  │  │   + metrics)           ││
│  └────────────┘  └────────────┘  └────────────────────────┘│
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Kafka Broker (Docker - Apache Kafka 4.1.0 / KRaft)    │ │
│  │  ├─ PLAINTEXT listener → host port 9092                │ │
│  │  └─ Topics: social-webhook-events, post-fix-test, ...  │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

---

## 🔄 Cross-Service Synchronization

### Shared Database Pattern
The MQTT server **reads** from MongoDB collections written by the web app:

| Collection | Written By | Read By | Purpose |
|------------|------------|---------|---------|
| `users` | Web App | MQTT Server | User identification |
| `devices` | Both | Both | Device metadata |
| `social_accounts` | Web App | MQTT Server | OAuth tokens for API calls |
| `ad_campaigns` | Web App | MQTT Server | Content to display |

### Kafka Event Bridge (Cross-Domain Publishing)
External apps (e.g., the Next.js web app) can push events into Kafka without a direct Kafka client by using this server as a bridge:

```javascript
// From the web app
await fetch('http://your-server:3002/api/kafka/publish', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    topic: 'social-webhook-events',
    payload: { type: 'instagram_update', userId: 'abc123' }
  })
});
```

The MQTT server receives the request, validates it, and publishes the event to Kafka on `localhost:9092`. Kafka is accessible on port `9092` and can be reached from any service that has network access to the host.

### Cache Invalidation via Redis Pub/Sub
When the web app updates device-related data, it publishes invalidation events:

```javascript
// Web app after disconnecting Instagram
await redis.publish('config:invalidate', deviceId);
```

The MQTT server subscribes and clears its Redis cache, ensuring the next stats cycle uses fresh data.

---

## Quick Start

### 1. Install Dependencies
```bash
cd services/mqtt-publisher-lite
npm install
```

### 2. Configure
```bash
cp .env.example .env
# Set required variables: MONGODB_URI, REDIS_HOST, MQTT credentials
```

### 3. Run
```bash
# Development mode (with hot reload)
npm run dev

# Production build
npm run build
npm start
```

### 4. Verify
```bash
curl http://localhost:3002/health
```

---

## PKI Architecture (Industrial Grade)

Seven security improvements transitioning the PKI from prototype to production-ready:

### 1. Structured CN Format
- **Legacy**: `PROOF-{deviceId}`
- **Production**: `PROOF-{ORDER_ID}-{BATCH}-{DEVICE_ID}`
- Enables revocation by order, batch, or individual device
- Configured via `CERT_CN_FORMAT=structured` (default: `legacy`)

### 2. Certificate Chain Validation
- RFC 5280 path validation from leaf to root
- Validates signatures, validity dates, basicConstraints, pathLenConstraint
- Rejects chains signed by untrusted roots
- Enabled via `INTERMEDIATE_CA_ENABLED=true`

### 3. Tamper-Proof Audit Log (InfluxDB)
- Every PKI event logged with SHA-256 hash chain
- Each entry references the previous entry's hash (linked list)
- Stored in InfluxDB (`pki_audit` measurement) for time-series dashboarding
- File fallback (`data/ca/audit.log`) if InfluxDB unavailable
- Chain integrity verification via `AuditService.verifyChain()`

### 4. Runtime KU/EKU Enforcement
- Validates Key Usage and Extended Key Usage on **every** device authentication
- Requires: `digitalSignature` KU, `clientAuth` EKU
- Prohibits: `keyCertSign` KU on device certificates
- Enabled by default (`ENFORCE_RUNTIME_KU_EKU=true`)

### 5. Certificate Renewal Grace Period
- **Renewal window**: 45 days before expiry (configurable)
- **Grace period**: 20 days after expiry — device accepted with warning
- **Hard expiry**: Rejected after grace period
- Prevents unplanned production outages during certificate rotation

### 6. Tiered Rate Limiting
All endpoints are rate-limited via Redis counters:

| Tier | Scope | Per-IP | Per-Device | Global |
|------|-------|--------|------------|--------|
| Global | All routes | 200 / 15min | — | 1000 / 1min |
| Provisioning | `/api/v1/*` | 30 / 15min | 15 / 15min | — |
| CSR (strictest) | `/api/v1/sign-csr` | 5 / 15min | 10 prov, 3 unprov / 15min | 100 CA / 1min |

Returns HTTP 429 with `Retry-After`, `X-RateLimit-*` headers. Rate limit events logged to InfluxDB.

### 7. Certificate Transparency Log
- Internal Merkle tree of all certificate issuances
- Inclusion proof generated for every issued certificate
- Stored in InfluxDB (`ct_log` measurement)
- Enables detection of rogue/unauthorized certificate issuances
- Enabled via `TRANSPARENCY_LOG_ENABLED=true`

## 🔐 Security & limitations (V5.0)

### Certificate revocation (NanoMQ)

This repo can **mark certificates revoked in MongoDB** and the Node service will **reject actions / drop traffic** from revoked or expired certificates.

**Known limitation (accepted for V5.0):** NanoMQ mTLS validation is **CA-chain only** and does **not** enforce CRL/OCSP/DB-backed revocation by default. A revoked device cert may still be able to complete an MQTT CONNECT at the broker layer.

**V6 hardening track:** implement broker-side auth (plugin/gateway) or migrate to a broker with first-class authn/authz plugins (e.g. EMQX).

---

## 📡 API Endpoints

### Health Check
```bash
GET /health
```

### Device Registration (Test)
```bash
POST /api/test/register
Content-Type: application/json

{
  "deviceId": "ESP32-ABC123",
  "userId": "user_id",
  "deviceType": "mobile",
  "os": "iOS 17.0"
}
```

### Device Provisioning (mTLS Flow)

#### Stage 1: Onboarding (Token Issuance)
```bash
POST /api/v1/onboarding
Authorization: Bearer <admin_jwt>
Content-Type: application/json

{ "device_id": "ESP32-ABC123" }
```

#### Stage 2: CSR Signing
```bash
POST /api/v1/sign-csr
Content-Type: application/json

{
  "device_id": "ESP32-ABC123",
  "csr": "<PEM-encoded CSR>",
  "provisioning_token": "<token from stage 1>"
}
```

#### Certificate Status
```bash
GET /api/v1/certificates/:deviceId/status
```

#### Revoke Certificate
```bash
DELETE /api/v1/certificates/:deviceId
Authorization: Bearer <admin_jwt>
```

### MQTT Publish
```bash
POST /api/publish
Content-Type: application/json

{
  "topic": "proof.mqtt/device_123/status",
  "payload": { "status": "online" },
  "qos": 1
}
```

### Device List
```bash
GET /api/devices
GET /api/devices?status=active
```

### Kafka Publish (Cross-Domain / External Apps)

Allows external web applications (e.g., Next.js frontend) to publish events to Kafka topics via this server's HTTP API without needing a direct Kafka client connection.

```bash
POST /api/kafka/publish
Content-Type: application/json

{
  "topic": "social-webhook-events",
  "key": "optional-key",
  "payload": { "type": "user_signup", "userId": "abc123" }
}
```

**Response:**
```json
{ "success": true, "topic": "social-webhook-events", "published": "2026-03-04T08:42:31.256Z" }
```

> **Note:** If `topic` is omitted, the message is sent to the `KAFKA_DEFAULT_TOPIC` (defaults to `social-webhook-events`).

---

## MQTT Topics

All topics use the root `proof.mqtt` (configurable via `MQTT_TOPIC_ROOT`).

| Topic | Direction | Description |
|-------|-----------|-------------|
| `proof.mqtt/{deviceId}/active` | Server -> Device | Device registration message |
| `proof.mqtt/{deviceId}/lwt` | Broker -> Server | Last Will and Testament (disconnect) |
| `proof.mqtt/{deviceId}/registration_ack` | Server -> Device | Registration acknowledgement |
| `proof.mqtt/{deviceId}/instagram` | Server -> Device | Instagram follower stats |
| `proof.mqtt/{deviceId}/gmb` | Server -> Device | Google My Business review stats |
| `proof.mqtt/{deviceId}/pos` | Server -> Device | Point-of-sale metrics |
| `proof.mqtt/{deviceId}/promotion` | Server -> Device | Promotion/brand canvas content |

---

## WebSocket API

```javascript
const ws = new WebSocket('ws://localhost:3002/ws');

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('MQTT message:', data);
};

// Subscribe
ws.send(JSON.stringify({ type: 'subscribe', topic: 'proof.mqtt/+/status' }));

// Publish
ws.send(JSON.stringify({
  type: 'publish',
  topic: 'proof.mqtt/device_123/status',
  payload: { status: 'online' },
  qos: 1
}));
```

---

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `MONGODB_URI` | MongoDB Atlas connection string |
| `REDIS_HOST` | Redis host (e.g., Redis Cloud) |
| `REDIS_PORT` | Redis port |
| `REDIS_PASSWORD` | Redis password |
| `AUTH_SECRET` | Auth secret for JWT validation |
| `JWT_SECRET` | JWT signing secret for provisioning tokens |

### MQTT

| Variable | Default | Description |
|----------|---------|-------------|
| `MQTT_BROKER` | `broker.emqx.io` | MQTT broker hostname |
| `MQTT_PORT` | `8883` | MQTT broker port |
| `MQTT_USERNAME` | — | MQTT username |
| `MQTT_PASSWORD` | — | MQTT password |
| `MQTT_TOPIC_ROOT` | `proof.mqtt` | Root topic prefix |
| `MQTT_TLS_ENABLED` | `false` | Enable TLS |
| `MQTT_TLS_CA_PEM` | — | Broker CA certificate (PEM, raw) |
| `MQTT_TLS_CLIENT_CERT_PEM` | — | Client certificate (PEM, raw) |
| `MQTT_TLS_CLIENT_KEY_PEM` | — | Client private key (PEM, raw) |

### PKI Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CERT_CN_FORMAT` | `legacy` | CN format: `legacy` or `structured` |
| `CERT_CN_PREFIX` | `PROOF_` | Certificate CN prefix |
| `DEVICE_CERT_VALIDITY_DAYS` | `90` | Device certificate validity |
| `CERT_RENEWAL_WINDOW_DAYS` | `45` | Days before expiry to start renewal |
| `CERT_GRACE_PERIOD_DAYS` | `20` | Days after expiry to accept with warning |
| `ENFORCE_RUNTIME_KU_EKU` | `true` | Enforce KU/EKU on every auth check |
| `INTERMEDIATE_CA_ENABLED` | `false` | Enable certificate chain validation |
| `AUDIT_HASH_CHAIN_ENABLED` | `true` | Enable SHA-256 hash-chained audit log |
| `TRANSPARENCY_LOG_ENABLED` | `false` | Enable certificate transparency Merkle tree |

### Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_GLOBAL_PER_IP` | `200` | Global: max requests per IP / 15min |
| `RATE_LIMIT_GLOBAL_PER_MIN` | `1000` | Global: max requests server-wide / 1min |
| `RATE_LIMIT_PROV_PER_IP` | `30` | Provisioning: max per IP / 15min |
| `RATE_LIMIT_PROV_PER_DEVICE` | `15` | Provisioning: max per device / 15min |
| `CSR_RATE_LIMIT_PROVISIONED` | `10` | CSR: max per provisioned device / 15min |
| `CSR_RATE_LIMIT_UNPROVISIONED` | `3` | CSR: max per unprovisioned request / 15min |
| `CSR_RATE_LIMIT_PER_IP` | `5` | CSR: max per IP / 15min |
| `CSR_RATE_LIMIT_GLOBAL` | `100` | CSR: max global CA operations / 1min |

### Kafka

| Variable | Default | Description |
|----------|---------|-------------|
| `KAFKA_ENABLED` | `false` | Enable Kafka integration |
| `KAFKA_BROKERS` | `localhost:9092` | Comma-separated broker list (e.g., `localhost:9092`) |
| `KAFKA_CLIENT_ID` | `mqtt-publisher-lite` | Kafka client identifier |
| `KAFKA_DEFAULT_TOPIC` | `social-webhook-events` | Default topic when none is specified in the publish request |
| `KAFKA_PUBLIC_IP` | `localhost` | Public IP or domain used in advertised listener; set to your server's IP for remote access |
| `KAFKA_SSL` | `false` | Enable SSL/TLS for Kafka connection |
| `KAFKA_SASL_MECHANISM` | — | SASL mechanism (`plain`, `scram-sha-256`, `scram-sha-512`) |
| `KAFKA_SASL_USERNAME` | — | SASL username (required if `KAFKA_SASL_MECHANISM` is set) |
| `KAFKA_SASL_PASSWORD` | — | SASL password (required if `KAFKA_SASL_MECHANISM` is set) |

### InfluxDB

| Variable | Default | Description |
|----------|---------|-------------|
| `INFLUXDB_ENABLED` | `true` | Enable InfluxDB integration |
| `INFLUXDB_URL` | `http://localhost:8086` | InfluxDB URL |
| `INFLUXDB_TOKEN` | — | InfluxDB API token |
| `INFLUXDB_ORG` | `statsmqtt` | InfluxDB organization |
| `INFLUXDB_BUCKET` | `metrics` | InfluxDB bucket |

### General

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3002` | HTTP server port |
| `HTTP_HOST` | `0.0.0.0` | HTTP server bind address |
| `NODE_ENV` | `development` | Environment |
| `LOG_LEVEL` | `info` | Log level (`debug`, `info`, `warn`, `error`) |
| `DATA_DIR` | `./data` | Data directory for CA certificates |

---

## Project Structure

| Feature | Full Version | Lite Version |
|---------|--------------|--------------|
| **Dependencies** | Redis, Kafka, InfluxDB, MongoDB | None |
| **Storage** | Distributed databases | Local JSON files |
| **Memory** | ~300MB | ~50MB |
| **Startup Time** | 30-60s | 2-3s |
| **Docker Image** | ~500MB | ~150MB |
| **Scalability** | High (multi-instance) | Low (single instance) |
| **Data Persistence** | High availability | Local only |
| **Best For** | Production | Development/Testing |

---

## 🎯 Use Cases

✅ **Perfect For:**
- Firmware development and testing
- IoT device prototyping
- Quick MQTT testing
- Local development
- CI/CD testing pipelines
- Educational purposes

❌ **Not Recommended For:**
- Production workloads
- High availability requirements
- Multi-instance deployments
- Large-scale data storage
- Distributed systems

---

## 🐛 Troubleshooting

### Can't connect to MQTT broker
```bash
# Test broker connectivity
telnet broker.emqx.io 1883

# Or use mosquitto
mosquitto_pub -h broker.emqx.io -t "test" -m "hello"
```

### Port 3002 already in use
```bash
# Change port in .env
HTTP_PORT=3003

# Or stop existing process
lsof -ti:3002 | xargs kill
```

### Data not persisting
- Check `data/` directory exists and has write permissions
- Verify `DATA_DIR` environment variable
- Check disk space

### MQTT messages not received
- Verify broker connection: Check `/health` endpoint
- Check topic prefix matches
- Verify QoS levels

---

## 🧭 Device Lifecycle V5.0 (firmware contract)

This section is the **firmware-facing contract** for the V5.0 flows (Boot Audit, Renewal, WiFi Reconfig, Reissue).

### mTLS identity for HTTP (proxy mode)

`/api/v1/certificates/renewAuth` and `/api/v1/certificates/confirm` authenticate the device via a **client certificate forwarded by a TLS-terminating proxy**.

- **Default header**: `X-Forwarded-Client-Cert` (full PEM; may be URL-encoded and/or contain escaped `\\n`)
- **Config**: set `MTLS_CLIENT_CERT_HEADER` to override
- **Fallback (not recommended)**: forward CN as a header and set `MTLS_CLIENT_CN_HEADER` + `MTLS_CN_IS_DEVICE_ID=true`

### HTTP endpoints used by firmware

#### Broker config (Flow 1)

- `GET /api/v1/mqtt-config`
  - Response: `{ broker, port, ca_cert }` where `ca_cert` is base64 PEM (or null)

#### Initial enrollment (existing)

- `POST /api/v1/onboarding` (user bearer token → provisioning token)
- `POST /api/v1/sign-csr` (provisioning token + CSR → primary device certificate)

#### Flow 2: Seamless Renewal (overlap, MQTT-validated)

- `POST /api/v1/certificates/renewAuth`
  - Auth: mTLS **primary** cert (via proxy header)
  - Body: `{ "csr": "<PEM CSR or base64(PEM CSR)>" }`
  - Response: `{ certificate, ca_certificate, expires_at, fingerprint, slot:"staging" }`

- `POST /api/v1/certificates/confirm`
  - Auth: mTLS **staging** cert (via proxy header)
  - Effect: **promote staging → primary** and **revoke old primary** (backend-level revocation)

Firmware rule: **Do not delete the old cert until MQTT connect succeeds with staging** and `confirm` returns 200.

#### Flow 4: Identity Re-Binding (reissue)

- `POST /api/v1/certificates/reissue`
  - Auth: `Authorization: Bearer <user_auth_token>`
  - Body: `{ "device_id": "<device_id>", "csr": "<PEM CSR or base64(PEM CSR)>" }`
  - Effect: revoke all active certs for device, issue a fresh **primary** cert

### Firmware flow mapping (V5.0)

- **Flow 1 (Boot Audit)**:
  - WiFi connect (NVS creds, retry/backoff)
  - NTP sync (fallback RTC + 48h grace)
  - integrity check: verify signature of `"PROOF_INTEGRITY_CHECK"`
  - cert parse: if expired/corrupt → Flow 4; if <30d → Flow 2
  - MQTT connect → OPERATIONAL

- **Flow 2 (Renewal)**:
  - generate staging keypair + CSR
  - `POST /certificates/renewAuth` (using primary cert for auth)
  - MQTT connect using staging cert/key (timeout 15s)
  - `POST /certificates/confirm` (using staging cert for auth)
  - promote staging assets → primary; re-sign integrity string

- **Flow 3 (WiFi Reconfig)**:
  - AP portal: `PROOF-{device_id}` SSID
  - dual-mode station test while AP stays alive
  - MQTT connect is the “internet OK” validator
  - commit WiFi + reboot → Flow 1

- **Flow 4 (Reissue)**:
  - AP portal: user submits `user_auth_token` (+ WiFi if empty)
  - generate staging keypair + CSR
  - `POST /certificates/reissue`
  - MQTT connect using new cert/key (timeout 15s)
  - commit staging → primary; re-sign integrity; wipe old flags; reboot → Flow 1

---

## 📝 Development

### Project Structure
```
mqtt-publisher-lite/
├── src/
│   ├── config/              # Configuration loading + PEM file handling
│   ├── middleware/           # Rate limiters (global, provisioning, CSR)
│   ├── models/              # Mongoose schemas (Device, User, Ad, Certificate, ACL)
│   ├── routes/              # Provisioning + config HTTP routes
│   ├── servers/             # HTTP, WebSocket, MQTT client managers
│   ├── services/
│   │   ├── auditService.ts       # SHA-256 hash-chained audit (InfluxDB)
│   │   ├── caService.ts          # Root CA, CSR signing, CN validation
│   │   ├── chainValidator.ts     # RFC 5280 certificate chain validation
│   │   ├── deviceService.ts      # Device CRUD + Redis ActiveDeviceCache
│   │   ├── influxService.ts      # InfluxDB: metrics, audit, CT log, rate limits
│   │   ├── kafkaService.ts       # Kafka producer (KafkaJS; publishes to broker)
│   │   ├── mongoService.ts       # MongoDB connection management
│   │   ├── provisioningService.ts # Token-based device provisioning
│   │   ├── redisService.ts       # Redis connection management
│   │   ├── statsPublisher.ts     # Periodic screen data publisher
│   │   ├── transparencyLog.ts    # Merkle tree certificate transparency (InfluxDB)
│   │   └── userService.ts        # User lookup (shared MongoDB with Next.js)
│   ├── storage/             # Token store (Redis-backed)
│   ├── utils/
│   │   ├── certValidator.ts      # Runtime KU/EKU enforcement
│   │   ├── kafkaRetry.ts         # Kafka connect retry with backoff
│   │   └── logger.ts             # Winston logger
│   ├── app.ts               # Main application orchestrator
│   └── index.ts             # Entry point
├── data/ca/                 # CA certificates + keys (gitignored)
├── docker-compose.yml       # Local InfluxDB for development
├── Dockerfile               # Production container
├── package.json
├── tsconfig.json
└── README.md
```

---

## Docker

### Development (with InfluxDB + Kafka)
The `docker-compose.yml` starts both **InfluxDB** and **Kafka** locally.

```bash
# Start all infrastructure services
docker compose up -d kafka influxdb

# Start the app
npm run dev
```

#### Kafka Docker Details
- **Image**: `apache/kafka:4.1.0` (native KRaft mode — no ZooKeeper required)
- **Listeners**: `PLAINTEXT://0.0.0.0:9092` (exposed for app and cross-domain access), `CONTROLLER://0.0.0.0:9093` (KRaft)
- **Advertised Listener**: `localhost:9092` (set `KAFKA_PUBLIC_IP` for remote access)

#### Cross-Domain / Remote Kafka Access
To allow an external server or domain to publish to Kafka:
1. Set `KAFKA_PUBLIC_IP=your.server.ip` in `.env` and ensure Kafka advertises that host.
2. Restart Kafka: `docker compose up -d kafka`
3. External clients connect to `your.server.ip:9092`

### Production Build
```bash
docker build -t mqtt-publisher-lite .
docker run -p 3002:3002 \
  -e MONGODB_URI=<uri> \
  -e REDIS_HOST=<host> \
  -e REDIS_PORT=<port> \
  -e REDIS_PASSWORD=<pass> \
  -e MQTT_BROKER=<broker> \
  -e MQTT_USERNAME=<user> \
  -e MQTT_PASSWORD=<pass> \
  -e KAFKA_ENABLED=true \
  -e KAFKA_BROKERS=<broker:port> \
  mqtt-publisher-lite
```

---

## Data Stores

| Store | Purpose | Data |
|-------|---------|------|
| **MongoDB** (primary) | Persistent data | Devices, Users, Ads, Certificates, ACLs |
| **Redis** (cache) | Low-latency cache + tokens | Active device cache, provisioning tokens, rate limit counters |
| **InfluxDB** (time-series) | Audit + metrics | PKI audit chain, certificate transparency log, rate limit events, device/social metrics |
| **Kafka** (event streaming) | Cross-domain event bus | Social webhook events, external app events (e.g. `social-webhook-events`) |

---

## Troubleshooting

### MongoDB connection fails
- Verify `MONGODB_URI` is set correctly
- Check your IP is whitelisted in MongoDB Atlas Network Access
- Test: `mongosh "<your_uri>"`

### Port already in use
```bash
lsof -ti:3002 | xargs kill -9
```

### MQTT connection fails
- Verify broker hostname, port, username, password
- Check TLS certificates if using mTLS
- Ensure `MQTT_TLS_CA_PEM` is set for TLS brokers

### Redis connection fails
- Verify `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`
- Check if Redis Cloud requires TLS (`REDIS_TLS=true`)

### InfluxDB not receiving data
- Verify `INFLUXDB_URL`, `INFLUXDB_TOKEN`, `INFLUXDB_ORG`, `INFLUXDB_BUCKET`
- For local dev: `docker compose up -d` starts InfluxDB on port 8086
- InfluxDB failures are non-fatal — the app continues without it

### Kafka not connecting / publish fails
- Ensure Kafka is running: `docker compose up -d kafka`
- Verify port 9092 is listening: `ss -tlnp | grep 9092`
- Ensure `KAFKA_ENABLED=true` and `KAFKA_BROKERS=localhost:9092` (or leave unset to use default) in `.env`
- Check Kafka container logs: `docker logs mqtt-lite-kafka --tail 50`
- **Connection retries**: The app retries Kafka connection with backoff (5 attempts). If the broker is slow to start, wait a few seconds and try again.
- **Multiple app instances**: If you see MQTT `clientId` conflicts or Kafka rebalances, kill duplicate `ts-node-dev` processes:
  ```bash
  pkill -f ts-node-dev
  ```
- **Topic not found**: Kafka uses `allowAutoTopicCreation: true` — topics are created on first publish automatically.
- **Test connectivity**:
  ```bash
  docker exec mqtt-lite-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list
  ```

---

## License

MIT License

---

## 📄 Additional Documentation

| Document | Description |
|----------|-------------|
| [INSTAGRAM_FETCH_SERVICE.md](./docs/INSTAGRAM_FETCH_SERVICE.md) | Architecture plan for the Kafka-based Instagram metrics fetch pipeline: consumer groups, batch processing, rate limiting, InfluxDB schema, and edge case handling |

