# 🚀 MQTT Publisher Lite

**Lightweight MQTT Publisher for Firmware Testing** - No external dependencies (Redis, Kafka, InfluxDB)!

## ✨ Features

- ✅ **Zero External Dependencies** - Just Node.js
- ✅ **File-Based Storage** - All data in simple JSON files
- ✅ **Fast Startup** - Ready in 2-3 seconds
- ✅ **Small Footprint** - ~50MB RAM usage
- ✅ **Self-hosted MQTT broker** - Production: `broker.withproof.io:8883` (mTLS / X.509)
- ✅ **HTTP API** - Full REST API for device/session management
- ✅ **WebSocket Support** - Real-time MQTT message streaming
- ✅ **Docker Ready** - Single container deployment
- ✅ **Perfect for Testing** - Ideal for firmware development

---

## 📋 Quick Start

### 1. Install Dependencies
```bash
cd services/mqtt-publisher-lite
npm install
```

### 2. Configure
```bash
cp .env.example .env
# Edit .env only for secrets and overrides (see Configuration — defaults in src/config/index.ts)
```

### 3. Run
```bash
# Development mode
npm run dev

# Production mode
npm run build
npm start
```

### 4. Test
```bash
# Run automated tests
npm test

# Or manually test
curl http://localhost:3002/health
```

---

## 📚 Documentation

| Topic | Location |
|-------|----------|
| Quick start (extended) | [`docs/QUICKSTART.md`](docs/QUICKSTART.md) |
| Device recovery / firmware | [`docs/DEVICE_RECOVERY_FIRMWARE.md`](docs/DEVICE_RECOVERY_FIRMWARE.md) |
| OTA firmware updates | [`docs/OTA_FIRMWARE_CONTRACT.md`](docs/OTA_FIRMWARE_CONTRACT.md) |
| Webhook migration | [`docs/WEBHOOK_MIGRATION.md`](docs/WEBHOOK_MIGRATION.md) |
| Redis setup & troubleshooting | [`docs/REDIS_CLOUD_SETUP.md`](docs/REDIS_CLOUD_SETUP.md), [`docs/REDIS_CONNECTION_FIX.md`](docs/REDIS_CONNECTION_FIX.md) |
| CSR / device certificates | [`docs/CSR_REQUIREMENTS_VALIDATION.md`](docs/CSR_REQUIREMENTS_VALIDATION.md) |
| Attention IoT polling | [`docs/attention-polling-status.md`](docs/attention-polling-status.md) |

Unit tests live under `tests/unit/` (mirrors `src/`). Integration: `tests/integration/connections.ts` (`npm run test:connections`). Ops scripts: `scripts/` (e.g. `scripts/integration-test.sh`, `scripts/run-migration.sh`).

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────┐
│  MQTT Publisher Lite                    │
│                                         │
│  ┌──────────────────────────────────┐  │
│  │  HTTP API (Express)              │  │
│  │  - /health                        │  │
│  │  - /api/sessions                 │  │
│  │  - /api/devices                  │  │
│  │  - /api/users                    │  │
│  │  - /api/publish                  │  │
│  └──────────────────────────────────┘  │
│                                         │
│  ┌──────────────────────────────────┐  │
│  │  WebSocket Server                │  │
│  │  - /ws                           │  │
│  └──────────────────────────────────┘  │
│                                         │
│  ┌──────────────────────────────────┐  │
│  │  MQTT Client                     │  │
│  │  → broker.withproof.io:8883    │  │
│  │     (mqtts + client cert)      │  │
│  └──────────────────────────────────┘  │
│                                         │
│  ┌──────────────────────────────────┐  │
│  │  File Storage                    │  │
│  │  - sessions.json                 │  │
│  │  - devices.json                  │  │
│  │  - users.json                    │  │
│  └──────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

---

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

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "mqtt": { "connected": true },
  "storage": {
    "sessions": 5,
    "devices": 10,
    "users": 3
  }
}
```

### Create Session
```bash
POST /api/sessions
Content-Type: application/json

{
  "clientId": "device-001",
  "active_account": "user@example.com",
  "social_accounts": [],
  "access_token": "token-123",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "expiresAt": "2024-01-02T00:00:00.000Z"
}
```

### Register Device
```bash
POST /api/devices
Content-Type: application/json

{
  "deviceId": "device-001",
  "clientId": "client-001",
  "username": "testuser",
  "metadata": {
    "firmware": "v1.0.0",
    "model": "ESP32"
  }
}
```

### Publish MQTT Message
```bash
POST /api/publish
Content-Type: application/json

{
  "topic": "devices/test/status",
  "payload": {"status": "online"},
  "qos": 0,
  "retain": false
}
```

### Get All Devices
```bash
GET /api/devices
```

### Create User
```bash
POST /api/users
Content-Type: application/json

{
  "userId": "user-001",
  "username": "testuser",
  "email": "test@example.com"
}
```

---

## 🔌 WebSocket API

### Connect
```javascript
const ws = new WebSocket('ws://localhost:3002/ws');

ws.onopen = () => {
  console.log('Connected');
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Message:', data);
};
```

### Subscribe to Topic
```javascript
ws.send(JSON.stringify({
  type: 'subscribe',
  topic: 'devices/+/status'
}));
```

### Publish Message
```javascript
ws.send(JSON.stringify({
  type: 'publish',
  topic: 'devices/test/command',
  payload: { command: 'restart' },
  qos: 0
}));
```

### Ping/Pong
```javascript
ws.send(JSON.stringify({ type: 'ping' }));
// Receives: { type: 'pong', timestamp: '...' }
```

---

## 📂 File Storage

All data is stored in `./data/` directory as JSON files:

### sessions.json
```json
{
  "session:device-001:1234567890": {
    "clientId": "device-001",
    "active_account": "user@example.com",
    "social_accounts": [],
    "access_token": "token-123",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "expiresAt": "2024-01-02T00:00:00.000Z"
  }
}
```

### devices.json
```json
{
  "device-001": {
    "deviceId": "device-001",
    "clientId": "client-001",
    "username": "testuser",
    "status": "active",
    "lastSeen": "2024-01-01T00:00:00.000Z",
    "metadata": {
      "firmware": "v1.0.0"
    }
  }
}
```

### users.json
```json
{
  "user-001": {
    "userId": "user-001",
    "username": "testuser",
    "email": "test@example.com",
    "devices": ["device-001", "device-002"],
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

---

## 🐳 Docker Usage

### Build
```bash
docker build -t mqtt-publisher-lite .
```

### Run
```bash
docker run -p 3002:3002 \
  -v $(pwd)/data:/app/data \
  --env-file .env \
  mqtt-publisher-lite
```

Production `.env` must include `MQTT_BROKER=broker.withproof.io`, `MQTT_PORT=8883`, and `MQTT_TLS_*_BASE64` client/CA material (see [MQTT TLS / mTLS](#mqtt-tls--mtls-production)).

### Docker Compose
```yaml
version: '3.8'
services:
  mqtt-publisher-lite:
    build: .
    ports:
      - "3002:3002"
    volumes:
      - ./data:/app/data
    env_file:
      - .env
    environment:
      - MQTT_BROKER=broker.withproof.io
      - MQTT_PORT=8883
      - MQTT_CLIENT_ID=proof-server
      - HTTP_PORT=3002
      - LOG_LEVEL=info
```

---

## 🧪 Testing

### Run Tests
```bash
npm test
```

### Manual Testing

#### Test MQTT Connection
```bash
# mTLS smoke test (same TLS path as the running app)
npm run test:mqtt-mtls

# Publish via HTTP API (app connects to broker.withproof.io:8883)
curl -X POST http://localhost:3002/api/publish \
  -H "Content-Type: application/json" \
  -d '{"topic":"test/hello","payload":{"msg":"hello"},"qos":0}'
```

#### Test WebSocket
```bash
# Using wscat
npm install -g wscat
wscat -c ws://localhost:3002/ws

# Subscribe to topic
> {"type":"subscribe","topic":"devices/+/status"}

# Publish message
> {"type":"publish","topic":"devices/test/status","payload":{"online":true}}
```

---

## 🔧 Configuration

Defaults are defined in `src/config/index.ts` and applied at startup. Copy `.env.example` to `.env` and set only what you need — most values can be omitted.

### Production MQTT broker

Self-hosted NanoMQ (or compatible) on the Proof domain:

| Setting | Value |
|---------|-------|
| Host | `broker.withproof.io` |
| Port | `8883` |
| URL | `mqtts://broker.withproof.io:8883` |
| Auth | Client X.509 (mTLS); no MQTT CONNECT username/password |
| Typical client ID | `proof-server` |

Required in `.env` for this deployment:

```bash
MQTT_BROKER=broker.withproof.io
MQTT_PORT=8883
MQTT_CLIENT_ID=proof-server
MQTT_TLS_CA_BASE64=...
MQTT_TLS_CLIENT_CERT_BASE64=...
MQTT_TLS_CLIENT_KEY_BASE64=...
```

Generate client material: `npm run pki -- app-client` (see `scripts/pki/README.md`). If `MQTT_BROKER` is a Railway TCP proxy (`*.proxy.rlwy.net`), set `MQTT_TLS_SERVERNAME=broker.withproof.io`.

### Core (MQTT & HTTP)

| Variable | Default (production) | Description |
|----------|----------------------|-------------|
| `MQTT_BROKER` | `broker.withproof.io` | Self-hosted MQTT broker hostname |
| `MQTT_PORT` | `8883` | mTLS port (`mqtts://`) |
| `MQTT_CLIENT_ID` | `proof-server` | Service MQTT client ID |
| `MQTT_TOPIC_PREFIX` | _(empty)_ | Optional prefix for all topics |
| `MQTT_TOPIC_ROOT` | `proof.mqtt` | Topic root for device paths |
| `MQTT_RECONNECT_PERIOD` | `2000` | mqtt.js reconnect interval (ms) |
| `MQTT_MAX_RECONNECT_ATTEMPTS` | `0` | Reconnect cap (`0` = infinite) |
| `PORT` / `HTTP_PORT` | `3002` | HTTP server port (`PORT` used on Render) |
| `HTTP_HOST` | `0.0.0.0` | HTTP bind address |
| `NODE_ENV` | `development` | Runtime environment |
| `LOG_LEVEL` | `info` | Winston log level (`debug`, `info`, `warn`, `error`) |
| `DATA_DIR` | `./data` | Local data directory |
| `SESSION_TTL` | `86400` | Session TTL (seconds) |
| `DEVICE_CLEANUP_INTERVAL` | `3600` | Device cleanup interval (seconds) |

### MongoDB connection pool

| Variable | Default | Description |
|----------|---------|-------------|
| `MONGODB_URI` | _(required)_ | MongoDB connection string |
| `MONGODB_DB_NAME` | `statsmqtt` | Database name |
| `MONGODB_MAX_POOL_SIZE` | `10` | Mongoose `maxPoolSize` |
| `MONGODB_MIN_POOL_SIZE` | `2` | Mongoose `minPoolSize` |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | `30000` | Atlas / DNS selection timeout |
| `MONGODB_CONNECT_TIMEOUT_MS` | `20000` | Initial connect timeout |

### App runtime & metrics

| Variable | Default | Description |
|----------|---------|-------------|
| `INFLUXDB_HEALTH_RETRIES` | `3` | Influx startup health probe attempts |
| `METRICS_INTERVAL_MS` | `10000` | Reserved metrics poll interval (ms) |
| `METRICS_RETENTION_DAYS` | `30` | Reserved retention hint (days) |
| `INFLUXDB_QUEUE_FLUSH_MS` | `5000` | Influx disk queue flush interval (ms) |
| `INFLUXDB_QUEUE_BATCH_MAX` | `500` | Max lines per Influx batch POST |
| `IG_POLL_BATCH_SIZE` | `50` | Instagram poller devices per batch |

### Feature flags (all default `true`)

Set to `false` only when you need to disable behavior. Loaded into `config.features` and HTTP/Influx wiring.

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_AUTO_START` | `true` | Reserved — app starts normally |
| `ENABLE_ERROR_REPORTING` | `true` | Reserved — error reporting hooks |
| `ENABLE_GRACEFUL_SHUTDOWN` | `true` | SIGINT/SIGTERM shutdown handlers |
| `ENABLE_HEALTH_CHECKS` | `true` | Full `/health` payload; `false` = minimal JSON |
| `ENABLE_METRICS_COLLECTION` | `true` | `false` disables Influx even if `INFLUXDB_TOKEN` is set |
| `ENABLE_REQUEST_LOGGING` | `true` | HTTP access logs; `false` disables request middleware logging |

### MQTT TLS / mTLS (production)

Broker and client PEMs are **env-only, in-memory** — not read from `data/.mqtt-tls/` or committed cert files.

| Variable | Default | Description |
|----------|---------|-------------|
| `MQTT_TLS_CA_BASE64` | _(unset)_ | Broker trust CA (base64 PEM) |
| `MQTT_TLS_CLIENT_CERT_BASE64` | _(unset)_ | Client certificate (base64 PEM) |
| `MQTT_TLS_CLIENT_KEY_BASE64` | _(unset)_ | Client private key (base64 PEM) |
| `MQTT_TLS_SERVERNAME` | _(auto)_ | SNI / cert verify host; for `*.proxy.rlwy.net` use `broker.withproof.io` |
| `MQTT_TLS_SKIP_PRECHECK` | `false` | Skip startup TLS handshake probe |
| mTLS auth mode | **on** | X.509-only when `MQTT_USERNAME` + `MQTT_PASSWORD` are not both set; no `MQTT_MTLS_ONLY` required |

Aliases: `MQTT_TLS_*_PEM`, `MQTT_TLS_CA_PEM`, `MQTT_TLS_CA_CERT`. Provisioning root CA: `MQTT_TLS_CA_BASE64` + `MQTT_TLS_CA_KEY_BASE64` (written under `src/certs/` for CAService).

### Integrations

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | _(unset)_ | Upstash / Redis (`rediss://`); required for Instagram poller & token persistence in production |
| `INSTAGRAM_SERVERLESS_URL` | _(unset)_ | Offload Instagram Graph fetches to this URL; unset = fetch in-process |
| `VERCEL_INSTAGRAM_FETCH_URL` | | Alias for `INSTAGRAM_SERVERLESS_URL` |
| `INFLUXDB_TOKEN` | _(unset)_ | Enables Influx when set (with `ENABLE_METRICS_COLLECTION=true`) |
| `INFLUXDB_URL` / `INFLUXDB_HOST` | `http://localhost:8086` | Influx 2.x base URL |

### Legacy environment names (deprecated)

Still accepted once per process with a log warning — prefer the canonical name:

| Legacy | Use instead |
|--------|-------------|
| `BATCH_SIZE` | `IG_POLL_BATCH_SIZE` |
| `BATCH_TIMEOUT` | `INFLUXDB_QUEUE_FLUSH_MS` |
| `CONNECTION_POOL_MAX` | `MONGODB_MAX_POOL_SIZE` |
| `CONNECTION_POOL_MIN` | `MONGODB_MIN_POOL_SIZE` |
| `MAX_RETRIES` | `INFLUXDB_HEALTH_RETRIES` |
| `METRICS_INTERVAL` | `METRICS_INTERVAL_MS` |
| `MQTT_MTLS_ONLY` | _(omit)_ — mTLS is default without username/password |

See `.env.example` for production broker (`broker.withproof.io:8883`), PKI scripts, and webhook URLs.

---

## 📊 Comparison with Full Version

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
# TLS handshake + mTLS (matches app startup pre-check)
npm run test:mqtt-mtls

# TCP reachability on mTLS port
openssl s_client -connect broker.withproof.io:8883 -servername broker.withproof.io </dev/null

# App logs should show:
# broker=broker.withproof.io port=8883 tlsServername=broker.withproof.io mqttAuth=X.509 only
```

Ensure `MQTT_TLS_*_BASE64` PEMs match the broker trust chain (`npm run pki:verify`). Plain `mosquitto_pub` on port 1883 does not apply to this deployment.

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

#### Flow 4: Factory reset recovery (JWT session + reissue)

1. Dashboard (authenticated): `POST /api/recovery/generate-session` (Next.js) → `POST /api/v1/recovery/generate-session` (MQTT)
   - Body: `{ "device_id": "<device_id>", "token": "<device_recovery_jwt>", "force_reissue": true }`
   - Registers (or replaces) Redis session `mqtt-lite:recovery:session:{device_id}` (15 min TTL, single-use)
2. Device AP portal: user opens `http://192.168.4.1/?token=<jwt>` and submits Wi‑Fi + token to device `POST /api/recovery/restore`
3. Device calls MQTT: `POST /api/v1/certificates/reissue`
   - Body: `{ "device_id", "csr", "recovery_token" }` (alias: `token`)
   - No user Bearer; validates JWT + Redis session, then consumes session

Firmware payload details: [`docs/DEVICE_RECOVERY_FIRMWARE.md`](docs/DEVICE_RECOVERY_FIRMWARE.md).

- `POST /api/v1/certificates/reissue`
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
  - Dashboard: `generate-session` → copy portal URL with `?token=`
  - AP portal: Wi‑Fi + `token` → device restore → MQTT reissue with `recovery_token`
  - generate keypair + CSR on device
  - `POST /certificates/reissue`
  - MQTT connect using new cert/key (timeout 15s)
  - commit staging → primary; re-sign integrity; wipe old flags; reboot → Flow 1

---

## 📝 Development

### Project Structure
```
mqtt-publisher-lite/
├── src/
│   ├── config/           # Configuration
│   ├── servers/          # HTTP, WebSocket, MQTT
│   ├── storage/          # File-based storage
│   ├── services/         # Business logic (if needed)
│   ├── types/            # TypeScript types
│   ├── utils/            # Utilities (logger, etc.)
│   ├── app.ts            # Main application
│   └── index.ts          # Entry point
├── data/                 # JSON data files (gitignored)
├── dist/                 # Compiled output
├── Dockerfile            # Docker configuration
├── package.json          # Dependencies
├── tsconfig.json         # TypeScript config
└── README.md             # This file
```

### Add New Functionality
1. Add types in `src/types/`
2. Create storage handler in `src/storage/`
3. Add HTTP endpoints in `src/servers/httpServer.ts`
4. Update app orchestrator in `src/app.ts`

---

## 📄 License

MIT License

---

## 🤝 Support

For issues or questions:
1. Check this README
2. Review logs: `npm run dev`
3. Test connectivity: `npm test`
4. Check data files in `./data/`

---

**Happy Firmware Testing! 🎯**
