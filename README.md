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
│  │  └─ ChainValidator    (RFC 5280 cert chain validation) │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────────┐│
│  │  MongoDB   │  │   Redis    │  │  InfluxDB              ││
│  │  (primary) │  │  (cache +  │  │  (audit + transparency ││
│  │            │  │   tokens)  │  │   + metrics)           ││
│  └────────────┘  └────────────┘  └────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

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

---

## API Endpoints

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
│   │   ├── mongoService.ts       # MongoDB connection management
│   │   ├── provisioningService.ts # Token-based device provisioning
│   │   ├── redisService.ts       # Redis connection management
│   │   ├── statsPublisher.ts     # Periodic screen data publisher
│   │   ├── transparencyLog.ts    # Merkle tree certificate transparency (InfluxDB)
│   │   └── userService.ts        # User lookup (shared MongoDB with Next.js)
│   ├── storage/             # Token store (Redis-backed)
│   ├── utils/
│   │   ├── certValidator.ts      # Runtime KU/EKU enforcement
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

### Development (with InfluxDB)
```bash
docker compose up -d    # Starts InfluxDB
npm run dev             # Starts the app
```

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
  mqtt-publisher-lite
```

---

## Data Stores

| Store | Purpose | Data |
|-------|---------|------|
| **MongoDB** (primary) | Persistent data | Devices, Users, Ads, Certificates, ACLs |
| **Redis** (cache) | Low-latency cache + tokens | Active device cache, provisioning tokens, rate limit counters |
| **InfluxDB** (time-series) | Audit + metrics | PKI audit chain, certificate transparency log, rate limit events, device/social metrics |

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

---

## License

MIT License
