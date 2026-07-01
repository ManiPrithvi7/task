

# 🏭 PRODUCTION-GRADE AUDIT GUIDE FOR CODEX AGENT
## ProofMQTT / `mqtt-publisher-lite` — Node.js MQTT Backend (Pilot v1)

---

## 0. CONTEXT & PROJECT UNDERSTANDING

**What this is:** A TypeScript/Node.js modular monolith serving as the backend for Proof/StatsMQTT IoT devices. It handles:
- mTLS MQTT communication with devices via NanoMQ broker (`broker.withproof.io:8883`)
- HTTP APIs for device provisioning, OTA firmware, recovery, webhooks
- Social media polling (Instagram, GMB) and stats publishing
- Device certificate lifecycle management

**Current state:** Functional but has security gaps, stale documentation, missing CI/CD, no linting, and scalability concerns. The security pentest (2026-06-23) identified **2 High, 4 Medium, 2 Low** severity items plus accepted temporary exceptions.

**Deployment target:** Railway (primary). No Render.

**Runtime target:** Bun (primary) for better performance. Node.js as fallback/compat.

**Goal:** Transform this into a production-grade codebase for the **Pilot v1** launch — minimal viable product for real-world market testing, with security hardening where it matters, but pragmatic about dev/testing conveniences.

---

## 1. SECURITY HARDENING (HIGHEST PRIORITY)

### 1.1 H-1: mTLS Fingerprint Binding at HTTP Edge
**File:** `src/middleware/mtlsAuth.ts` — `requireMtlsDeviceCert`

**Current flaw:** Middleware parses `x-forwarded-client-cert` and resolves `deviceId` from PEM, but does **NOT** compare the presented cert's fingerprint to the stored `certDoc.fingerprint` in MongoDB.

**Attack vector:** If a reverse proxy forwards a client-supplied `x-forwarded-client-cert` header, an attacker with a stolen device cert PEM can impersonate that device.

**Required changes:**
```typescript
// In requireMtlsDeviceCert, AFTER resolving identity from cert PEM:
const presentedFingerprint = identity.fingerprint256; // SHA-256 fingerprint of presented cert
const storedFingerprint = certDoc.fingerprint; // from MongoDB cert document

if (presentedFingerprint !== storedFingerprint) {
  logger.warn({ deviceId: resolvedDeviceId }, 'mTLS fingerprint mismatch — possible cert replay attack');
  return res.status(403).json({ error: 'Certificate fingerprint mismatch' });
}
```

**Request format impact:** NONE. This is purely a backend validation addition. The HTTP request format from devices/proxy stays identical. No changes to request headers, body, or response format (except the new 403 case).

**Also add:** Proxy hardening config documentation — the reverse proxy MUST strip `x-forwarded-client-cert` from external requests and only set it after TLS termination. Add a comment in the middleware: `// IMPORTANT: This middleware assumes the reverse proxy strips x-forwarded-client-cert from client requests.`

---

### 1.2 H-2: Admin JWT Scope Hardening (Interim → Permanent)
**File:** `src/routes/otaAdminRoutes.ts` — `requireAdminAuth`

**Context from product team:** 
- Web app handles authentication UI
- Same `AUTH_TOKEN` is used across frontend and backend
- Frontend has admin pages for OTA and admin functionalities
- End users do NOT know about admin routes (internal team only)

**Current flaw:** Any valid JWT signed with `AUTH_SECRET` can access admin OTA routes. No role claim or allowlist.

**Required changes:**
```typescript
// Add to JWT payload validation:
interface AuthToken {
  userId: string;
  email: string;
  role?: string; // 'admin' | 'user'
}

// In requireAdminAuth:
const ADMIN_ROLES = ['admin'];
const ADMIN_EMAIL_DOMAINS = (process.env.ADMIN_EMAIL_DOMAINS || '').split(',').filter(Boolean);
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '').split(',').filter(Boolean);

function requireAdminAuth(req, res, next) {
  const auth = verifyAuthToken(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  
  const isAdmin = 
    ADMIN_ROLES.includes(auth.role) ||
    ADMIN_EMAIL_DOMAINS.some(d => auth.email?.endsWith(`@${d}`)) ||
    ADMIN_USER_IDS.includes(auth.userId);
    
  if (!isAdmin) {
    logger.warn({ userId: auth.userId, email: auth.email }, 'Admin route access denied');
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  next();
}
```

**Frontend impact:** The web app must include `role: 'admin'` in the JWT payload when issuing tokens for admin users. Update the web app's auth service to set this claim. Non-admin users will get 403 when hitting admin routes — this is expected and correct.

**Add env vars to `.env.example`:**
```
ADMIN_EMAIL_DOMAINS=withproof.io
ADMIN_USER_IDS=
```

---

### 1.3 DEV-1: Keep Dev OTA Route — Rename for Pilot v1
**File:** `src/routes/otaRoutes.ts`

**Context from product team:** Pilot v1 needs a minimal OTA download endpoint for real-world market testing. The firmware and development team requested keeping this functionality as `GET /api/v1/ota/download/{ota:version}`.

**Required changes:**
1. Rename `GET /api/v1/ota/download/test:1.1` → `GET /api/v1/ota/download/:version`
2. Add basic validation: version must match semver or your firmware version format
3. Add a `PILOT_MODE` feature flag:
```typescript
if (process.env.PILOT_MODE !== 'true') {
  return res.status(404).json({ error: 'Not found' });
}
```
4. Add rate limiting (e.g., 10 req/min per IP)
5. Log every access with `logger.warn` so it's visible in production logs
6. Add a TODO comment: `// PILOT v1 ONLY — remove or protect before GA`

**Document in `docs/PILOT_V1_EXCEPTIONS.md`:**
```
## OTA Download Endpoint (Pilot v1)

- Route: GET /api/v1/ota/download/:version
- Auth: None (intentional for Pilot)
- Reason: Firmware team needs minimal OTA for real-world testing
- Risk: Low — version-scoped, rate-limited, logged
- Cleanup: Remove or add mTLS before GA
```

---

### 1.4 M-1: Remove WebSocket Server Completely
**File:** `src/servers/webSocketServer.ts`, `src/app.ts`

**Context from product team:** No usage of WebSocket in the app. Remove entirely.

**Required changes:**
1. Delete `src/servers/webSocketServer.ts`
2. Remove WebSocket imports and initialization from `src/app.ts`
3. Remove WebSocket-related env vars from `.env.example`
4. Remove WebSocket docs from README
5. Remove WebSocket tests
6. Update `src/app.ts` stop sequence to not close WebSocket

---

### 1.5 M-2: Trim Health Endpoint Information Disclosure
**Files:** Health endpoints across the app

**Current:** `GET /health` returns device counts, MQTT ack state, session count, webhook readiness.

**Required changes:**
```typescript
// Add a 'public' vs 'internal' health mode:
function getHealth(req) {
  const isInternal = req.ip === '127.0.0.1' || req.headers['x-internal-health'] === process.env.INTERNAL_HEALTH_SECRET;
  
  if (!isInternal) {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
  
  // Full payload for internal/ops only
  return { status: 'ok', mqtt: { connected: true }, storage: { ... }, ... };
}
```

**Also:** Restrict `/health/webhooks` to internal network or API key.

---

### 1.6 M-3: CORS Origin Restriction
**File:** `src/servers/httpServer.ts`

**Current:** `cors()` with no origin filter.

**Required:**
```typescript
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '').split(',').filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : false,
  credentials: true
}));
```

**Add to `.env.example`:**
```
CORS_ALLOWED_ORIGINS=https://app.withproof.io,https://dashboard.withproof.io
```

---

### 1.7 M-4: CSR Rate Limiter — Fallback to Local Cache
**File:** `src/middleware/csrRateLimiter.ts`

**Context from product team:** Use local in-memory cache as fallback when Redis is unavailable.

**Required changes:**
```typescript
import NodeCache from 'node-cache';

const localRateCache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

async function checkCsrRateLimit(deviceId: string): Promise<boolean> {
  if (config.redis.enabled && redisService.isConnected()) {
    // Use Redis for distributed rate limiting
    const key = `csr:rate:${deviceId}`;
    const count = await redisService.incr(key);
    if (count === 1) await redisService.expire(key, 60);
    return count <= 5; // 5 CSR requests per minute
  }
  
  // Fallback: local in-memory rate limiting (per-instance only)
  const key = `csr:rate:${deviceId}`;
  const count = (localRateCache.get<number>(key) || 0) + 1;
  localRateCache.set(key, count, 60);
  return count <= 5;
}
```

**Note:** Local cache is per-instance only. In multi-instance deployments, rate limits won't be shared. Document this limitation. For Pilot v1 (single instance), this is acceptable.

---

### 1.8 L-1: Remove Static Dev UI Completely
**File:** `public/` static serving

**Context from product team:** Remove completely.

**Required changes:**
1. Delete the entire `public/` directory
2. Remove `app.use(express.static('public'))` from `src/servers/httpServer.ts`
3. Remove `public/` from any build/copy scripts
4. Update README to remove references to the static UI

---

### 1.9 Remove Committed Private Keys from Repo
**Files:** `src/Proof-ca/*.key`, `src/certs/root-ca.key`, `data/ca/root-ca.key`, `data/mqtt-client/client.key`, `broker/certs/broker.key`

**Required:**
1. Add these paths to `.gitignore` if not already there
2. Rotate any keys that were ever real (treat all as compromised)
3. Replace with env-only injection (already partially done via `MQTT_TLS_*_BASE64`)
4. Add a `scripts/pki/.gitignore` to prevent future commits
5. Add pre-commit hook (see Section 7) to block `.key`, `.pem` private key files

---

## 2. RUNTIME & DEPENDENCY MODERNIZATION

### 2.1 Migrate to Bun Runtime
**Files:** `package.json`, `Dockerfile`, `tsconfig.json`, all npm scripts

**Context from product team:** Bun is the primary runtime for better performance.

**Required changes:**

**`package.json`:**
```json
{
  "name": "mqtt-publisher-lite",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "build": "bun build ./src/index.ts --outdir ./dist --target bun",
    "start": "bun run ./dist/index.js",
    "test": "bun test",
    "test:unit": "bun test tests/unit",
    "test:connections": "bun test tests/integration/connections.ts",
    "lint": "eslint src/ tests/ --ext .ts",
    "lint:fix": "eslint src/ tests/ --ext .ts --fix",
    "format": "prettier --write \"src/**/*.ts\" \"tests/**/*.ts\"",
    "coverage": "bun test --coverage",
    "typecheck": "tsc --noEmit"
  },
  "engines": {
    "bun": ">=1.1.0"
  }
}
```

**`Dockerfile`:**
```dockerfile
# Use official Bun image
FROM oven/bun:1.1-alpine AS builder

WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# Production stage
FROM oven/bun:1.1-alpine

RUN addgroup -g 1001 -S bunjs && adduser -S bunjs -u 1001
WORKDIR /app

COPY --from=builder --chown=bunjs:bunjs /app/dist ./dist
COPY --from=builder --chown=bunjs:bunjs /app/node_modules ./node_modules
COPY --from=builder --chown=bunjs:bunjs /app/package.json ./

USER bunjs

ENV NODE_ENV=production
ENV PORT=3002

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:3002/health').then(r => r.ok ? process.exit(0) : process.exit(1))"

CMD ["bun", "run", "./dist/index.js"]
```

**`.dockerignore`:**
```
node_modules
.git
.gitignore
README.md
.env
.env.*
coverage
dist
tests
docs
*.md
*.key
*.pem
data/
```

**`tsconfig.json` adjustments:**
- Ensure `"module": "ESNext"` and `"moduleResolution": "bundler"` for Bun compatibility
- Add `"types": ["bun-types"]` to compilerOptions

**Migration checklist:**
- [ ] Replace all `npm` commands with `bun` in scripts
- [ ] Replace `ts-node-dev` with `bun --watch`
- [ ] Replace `jest` with `bun:test` (or keep jest if bun test lacks features you need)
- [ ] Verify `mqtt` package works with Bun (it should — it's pure JS)
- [ ] Verify `mongoose` works with Bun (it should)
- [ ] Test `bun build` produces working output
- [ ] Test Docker build end-to-end

**If `bun:test` is insufficient**, keep Jest but run it via `bunx jest` for now. Document the plan to migrate fully to `bun:test` in v2.

---

### 2.2 Add ESLint + Prettier
**New files:** `.eslintrc.json`, `.prettierrc`, `.eslintignore`

**Required:**
```json
// .eslintrc.json
{
  "root": true,
  "parser": "@typescript-eslint/parser",
  "plugins": ["@typescript-eslint"],
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:@typescript-eslint/recommended-requiring-type-checking"
  ],
  "parserOptions": {
    "project": "./tsconfig.json"
  },
  "rules": {
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/await-thenable": "error",
    "no-console": "warn"
  }
}
```

```json
// .prettierrc
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "es5",
  "printWidth": 100
}
```

**Add to `package.json` devDependencies:**
```
@typescript-eslint/eslint-plugin
@typescript-eslint/parser
eslint
prettier
```

**Add npm scripts:**
```json
"lint": "eslint src/ tests/ --ext .ts",
"lint:fix": "eslint src/ tests/ --ext .ts --fix",
"format": "prettier --write \"src/**/*.ts\" \"tests/**/*.ts\""
```

---

### 2.3 Remove Render Configurations
**Files:** `render.yaml`, any Render-specific files

**Context from product team:** Railway is the primary deployment channel. Remove all Render configs.

**Required:**
1. Delete `render.yaml`
2. Remove Render-specific env vars from `.env.example` (`REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`)
3. Update README to mention Railway only
4. If any code references Render-specific env vars, update to use Railway equivalents

---

### 2.4 Audit & Update Dependencies
**File:** `package.json`

**Required:**
1. Run `bun audit` — fix all high/critical vulnerabilities
2. Pin exact versions or use `bun.lockb` properly
3. Remove unused dependencies
4. Update `engines` to specify Bun version

---

## 3. OBSERVABILITY & MONITORING

### 3.1 Add Universal Correlation ID Middleware
**New file:** `src/middleware/correlationId.ts`

**Required:** Every HTTP request and MQTT message should carry a `x-correlation-id` or generated UUID. Propagate to:
- Winston logger (auto-inject into all log lines)
- InfluxDB metrics tags
- MQTT publish headers (if supported by broker)

```typescript
// src/middleware/correlationId.ts
import { v4 as uuidv4 } from 'uuid';

export function correlationIdMiddleware(req, res, next) {
  const id = req.get('x-correlation-id') || uuidv4();
  req.correlationId = id;
  res.setHeader('x-correlation-id', id);
  next();
}
```

---

### 3.2 Add Prometheus Metrics Endpoint
**New file:** `src/middleware/metrics.ts`

**Required:** Add `prom-client` for key metrics:
- `http_requests_total` (counter, labeled by method, route, status)
- `http_request_duration_seconds` (histogram)
- `mqtt_messages_received_total` (counter, labeled by topic pattern)
- `mqtt_messages_published_total` (counter)
- `mqtt_connected_devices` (gauge)
- `redis_connection_state` (gauge)
- `mongo_connection_state` (gauge)
- `active_device_count` (gauge)

**Expose at:** `/metrics` (internal only, not public)

---

### 3.3 Structured Logging Improvements
**File:** `src/utils/logger.ts`

**Required:**
1. Add `correlationId` to every log line automatically
2. Add `service` field (e.g., `proofmqtt`)
3. Add `environment` field
4. Redact sensitive fields (`password`, `token`, `cert`, `key`, `privateKey`) from log output
5. Add separate error log stream (file transport) for production

---

### 3.4 InfluxDB as Primary Dependency
**Context from product team:** InfluxDB is primary for device transaction and connection logs.

**Required:**
1. Make InfluxDB a **required** dependency (not optional)
2. On startup, if InfluxDB is unreachable, fail fast with clear error
3. Add InfluxDB health check to `/health` (critical dependency)
4. Ensure all device connections, disconnections, OTA events, and certificate operations are logged to InfluxDB
5. Add retention policy config for InfluxDB (default 30 days, configurable via env)

**Update `.env.example`:**
```
INFLUXDB_URL=http://localhost:8086
INFLUXDB_TOKEN=required
INFLUXDB_ORG=withproof
INFLUXDB_BUCKET=devices
INFLUXDB_RETENTION_DAYS=30
```

---

## 4. TESTING & QUALITY

### 4.1 Add Test Coverage with Bun
**File:** `package.json`

**Required:**
```json
"scripts": {
  "coverage": "bun test --coverage",
  "coverage:report": "bun test --coverage --reporter=lcov"
}
```

**Add thresholds (if bun test supports them, else document manual check):**
- Branches: 70%
- Functions: 70%
- Lines: 70%
- Statements: 70%

---

### 4.2 Add Security-Focused Tests
**New/updated files:** Test files for security controls

**Required tests:**
1. mTLS fingerprint mismatch → 403
2. Admin JWT without admin role → 403
3. CSR rate limiter with Redis down → uses local cache (verify limit enforced)
4. Health endpoint public vs internal payload difference
5. CORS blocked origin → preflight failure
6. OTA pilot route works when `PILOT_MODE=true`, 404 when `false`
7. Private key files not in git → verify `.gitignore`

---

## 5. CI/CD & DEPLOYMENT

### 5.1 Add GitHub Actions CI/CD
**New file:** `.github/workflows/ci.yml`

**Required pipeline:**
```yaml
name: CI

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - run: bun run lint
      - run: bun run typecheck
      - run: bun run build
      - run: bun test
      - run: bun run coverage
```

### 5.2 Add Dockerfile Hardening (Bun-based)
**File:** `Dockerfile`

Already covered in 2.1. Key points:
- Multi-stage build
- Non-root user (`bunjs`)
- Health check using Bun
- `.dockerignore` excluding tests, docs, keys

### 5.3 Add Railway Deployment Config
**New file:** `railway.json` (if not present)

**Required:**
```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "Dockerfile"
  },
  "deploy": {
    "startCommand": "bun run ./dist/index.js",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

---

## 6. SCALABILITY & PERFORMANCE

### 6.1 MQTT Buffer Sizing
**File:** `src/services/mqttIngressRouter.ts`

**Current:** Non-critical message buffer capped at 100.

**Required:** Make configurable:
```typescript
const MQTT_BUFFER_SIZE = parseInt(process.env.MQTT_BUFFER_SIZE || '100', 10);
const MQTT_BUFFER_OVERFLOW = process.env.MQTT_BUFFER_OVERFLOW || 'drop'; // 'drop' | 'block' | 'error'
```

---

### 6.2 Add Fleet Size Documentation
**New file:** `docs/CAPACITY.md`

**Required:** Document for Pilot v1:
- Target fleet size (e.g., 100-500 devices for pilot)
- Memory per device estimate
- Redis keys per device
- MongoDB documents per device
- Recommended Railway instance sizing

---

## 7. CODE QUALITY & MAINTAINABILITY

### 7.1 Add Pre-commit Hooks (Local Build + Test)
**New file:** `.husky/pre-commit`

**Context from product team:** Keep local build and test in pre-commit.

**Required:**
```bash
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

# Block private keys
if git diff --cached --name-only | grep -E '\.(key|pem)$'; then
  echo "ERROR: Private key files detected. Use env injection instead."
  exit 1
fi

# Run build and test locally
bun run build
bun run test:unit
bun run lint
```

**Setup:**
```bash
bun add -d husky
bunx husky install
```

---

### 7.2 Update README
**File:** `README.md`

**Required changes:**
1. Update "zero external dependencies" → mention MongoDB, Redis, InfluxDB as required
2. Remove file JSON storage references
3. Add architecture diagram (Mermaid)
4. Add deployment checklist
5. Add security considerations section
6. Add monitoring/observability section
7. Update for Bun runtime
8. Update for Railway deployment
9. Document Pilot v1 exceptions

---

## 8. EXECUTION ORDER FOR CODEX AGENT

Work in this exact priority order. Each block should be a separate PR:

| Phase | Priority | Items | Est. Effort |
|-------|----------|-------|-------------|
| **P0** | Critical | 1.1 (mTLS fingerprint), 1.2 (admin JWT), 1.9 (remove keys from repo), 2.1 (Bun migration), 2.3 (Remove Render) | 3-4 days |
| **P1** | High | 1.4 (Remove WS), 1.5 (health trim), 1.6 (CORS), 1.7 (CSR local cache), 1.8 (remove static UI), 1.3 (Pilot OTA route), 3.4 (InfluxDB primary) | 3-4 days |
| **P2** | Medium | 2.2 (ESLint/Prettier), 2.4 (dependency audit), 3.1 (correlation ID), 3.2 (Prometheus), 3.3 (logging) | 3-4 days |
| **P3** | Medium | 4.1 (coverage), 4.2 (security tests), 5.1 (CI/CD), 5.2 (Docker), 5.3 (Railway) | 2-3 days |
| **P4** | Low | 6.1 (buffer sizing), 6.2 (capacity docs), 7.1 (pre-commit), 7.2 (README) | 2-3 days |

---

## 9. DEFINITION OF DONE

Before calling this "production-grade Pilot v1," verify:

- [ ] All security pentest findings remediated or explicitly accepted with documented risk
- [ ] `bun audit` returns zero high/critical vulnerabilities
- [ ] `bun run lint` passes with zero errors
- [ ] `bun test` passes with >70% coverage
- [ ] `bun run build` produces clean output
- [ ] CI/CD pipeline runs green on every PR
- [ ] No `.key` or private cert files in git history
- [ ] Docker image runs as non-root
- [ ] Health endpoint distinguishes public/internal payloads
- [ ] Admin routes require admin role
- [ ] InfluxDB is required dependency (not optional)
- [ ] WebSocket server removed
- [ ] Static UI removed
- [ ] Pilot OTA route documented and rate-limited
- [ ] All env vars documented in `.env.example`
- [ ] README accurately reflects Bun + Railway + current architecture

---
