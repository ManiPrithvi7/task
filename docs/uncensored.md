# ProofMQTT Server — Uncensored Report

**Product:** StatsMQTT Lite (`StatsMqttLite`) — MQTT broker integration, device provisioning/PKI, OTA firmware delivery, social metrics polling, GMB webhooks, and campaign/screen publishing in one Node/Bun process.

**Generated from codebase review:** July 2026  
**Scope:** `src/`, `tests/`, `stimulate/` — not marketing docs.

---

## Executive summary

This server does real work: mTLS-bound device identity, staged OTA rollouts with abort logic, hash-chained PKI audit logs, and recovery flows. That layer is **better than average** for an IoT pilot.

The product as a whole suffers from **mission creep** (Instagram polling, GMB Pub/Sub, Shopify campaigns, synthetic stimulate ramps) wired into a **2,228-line god class**, **107 environment variables**, and **security-critical paths that still lack direct test coverage**. It is operable for a controlled pilot; it is not yet a maintainable platform without deliberate extraction and hardening.

---

## 1. Architecture

### What it is

`src/app.ts` exports `StatsMqttLite` (~2,228 lines). One class owns:

- MQTT client lifecycle and ingress routing
- HTTP server bootstrap and route registration
- Device registration on `/active`
- OTA delivery on registration and reconnect
- Instagram polling scheduler startup
- Stimulate (synthetic metrics) in-process workers
- TLS pre-checks, keep-alive, graceful shutdown
- Wiring for ~35 services, 11 route modules, webhooks, jobs

Routes are registered imperatively inside `initializeHttpServer()` — no DI container, no module boundary enforcement.

### Strengths

- Folder layout is coherent in spirit: `config/` → `services/` → `routes/` → `models/` → `storage/`
- HTTP concerns split into route files (`provisioningRoutes`, `lifecycleRoutes`, `otaRoutes`, etc.)
- Middleware is small and focused (5 files under `src/middleware/`)

### Problems

| Issue | Detail |
|-------|--------|
| God object | `StatsMqttLite` is the integration hub for every subsystem |
| High coupling | Services reach for singletons (`getInfluxService`, `getRedisService`, `getAuditService`) |
| Manual wiring | Each new feature adds constructor args, imports, and `app.ts` branches |
| Feature entanglement | OTA, IG polling, GMB webhooks, and campaigns share MQTT publish paths and Redis keys |

**Grade: D** — Works for a single deployment; painful to extend, split, or reason about under load.

---

## 2. Security — the good, the bad, the ugly

### Good

- **mTLS fingerprint binding** (`src/middleware/mtlsAuth.ts`): reads client cert from proxy headers or native TLS, normalizes PEM, compares SHA-256 fingerprint against Mongo `DeviceCertificate.fingerprint`. Mismatch → 403 with audit-friendly codes.
- **Certificate lifecycle**: primary/staging slots, promotion, recovery sessions (Redis JWT), chain validation, optional KU/EKU enforcement via config.
- **Hash-chained audit log** (`auditService.ts`): SHA-256 linked entries with sequence numbers, persisted to InfluxDB compliance bucket; verification API exists.
- **CSR rate limiting** (`csrRateLimiter.ts`): per-device, per-IP, unprovisioned, and global CA tiers; Redis-backed with in-process fallback.
- **CSR validation** (`caService.ts`): RSA-only (node-forge constraint), minimum 2048-bit keys, device ID must appear in CSR CN/SAN.
- **Recovery reissue** requires prior `generate-session` + Redis-backed recovery token validation before `revokeAllDeviceCertificates` + `signCSR`.

### Bad

- **Default JWT secret fallback** — if `JWT_SECRET` and `PROVISIONING_JWT_SECRET` are both unset:

  ```ts
  // src/config/index.ts
  jwtSecret: process.env.JWT_SECRET || process.env.PROVISIONING_JWT_SECRET
    || 'mqtt-publisher-lite-secret-key-change-in-production'
  ```

  Any dev/staging deploy without env overrides compromises provisioning tokens.

- **`caService === null` fail-open on MQTT registration** — when `requireMtlsForRegistration` is true but PKI is not wired, `ensureDeviceProvisioned()` returns `true` (lines ~1030–1031 in `app.ts`). Misconfiguration disables registration gate entirely.

- **Reissue route has no mTLS** — `POST /api/v1/certificates/reissue` (`lifecycleRoutes.ts`) accepts `device_id`, `csr`, and `recovery_token` only. Design intent: recovery path. Risk: compromised recovery session + Redis → attacker can revoke all device certs and issue a new primary in one call.

- **Admin OTA auth** — `otaAdminRoutes.ts` grants admin if JWT `role === 'admin'`, email domain is in comma-separated `ADMIN_EMAIL_DOMAINS`, or `userId` is in `ADMIN_USER_IDS`. No RBAC integration; domain list in env is weak for production IAM.

- **`X-Forwarded-Proto` trust** — certificate download URLs in `provisioningRoutes.ts` use:

  ```ts
  const protocol = req.protocol || (req.get('x-forwarded-proto') ?? 'http');
  ```

  If the reverse proxy does not strip client-supplied `X-Forwarded-Proto`, download links can be downgraded or forged.

- **OTA release webhook** — `POST /api/webhooks/ota-release` protected by single bearer secret (`OTA_RELEASE_WEBHOOK_SECRET`). Leak = arbitrary firmware ingest.

### Ugly (corrected from prior drafts)

- **MongoDB errors on registration do *not* bypass mTLS.** `findActiveCertificateByDeviceId()` throws `CertLookupUnavailableError` on DB blips (distinct from missing cert → `false`). MQTT ingress drops/retries rather than treating as unprovisioned. Only **`!caService`** is a hard reject when the gate is enabled.

- **mTLS HTTP middleware fails closed on DB blip** with 503 `CERT_LOOKUP_UNAVAILABLE`. Missing cert → 403 `CERT_NOT_ACTIVE`. Fingerprint mismatch → 403.

- **No CRL/OCSP.** Revocation is soft (`status` field in MongoDB). Connected devices are not checked against a distribution point at runtime.

- **JWT example in config comments** (`config/index.ts` ~1025–1029): literal encrypted JWT in commented curl — remove or redact; copy-paste risk in shared repos.

**Grade: B−** — PKI fundamentals are solid; operational misconfig and recovery/reissue paths are the real liabilities.

---

## 3. OTA subsystem — ambitious and footgun-prone

**Primary file:** `src/services/otaService.ts` (~1,843 lines)

### Capabilities

- Release ingestion (CI webhook + manual admin routes)
- Percentage-tier staged rollouts with failure-rate abort (`jobs/rolloutScheduler.ts`)
- Staging slot promotion and rollback semantics
- Auth failure thresholds, cooldowns, device/version blocks
- MQTT push (QoS 1) with delivery tracking
- Download modes: HTTP proxy, presigned OCI PAR, MQTT-embedded URLs
- Slack alerts (`notifications/slackOta.ts`)
- Append-only release log (`otaReleaseLog.ts` → InfluxDB)

### Real problems

| Risk | Detail |
|------|--------|
| `TEST_OTA=true` | Bypasses version gates, eligibility, and rollout percentages. Forces test firmware to registering devices and can fan out fleet-wide on startup. Still in production code paths (`app.ts`, `otaRoutes.ts`). |
| Registration fan-out | `deliverOtaOnRegistration()` calls `deliverPendingToDevice()` on every device reconnect with a known firmware version. Mass reconnect after outage = simultaneous OTA evaluation storm. |
| Implicit success | `maybeRecordImplicitOtaSuccess()` infers OTA success when a device boots a newer version — no cryptographic attestation. |
| Single webhook secret | High-privilege ingest; no mTLS or signed payload requirement on webhook itself (beyond bearer). |

### Test coverage (exists, not zero)

- `tests/unit/services/otaService.test.ts` — rollout matching, failure blocks, MQTT payload
- `tests/unit/jobs/rolloutScheduler.test.ts` — abort on failure rate, advance on healthy stage
- `tests/unit/utils/otaRollout.test.ts` — abort threshold math
- `tests/unit/routes/otaWebhookRoutes.test.ts` — webhook ingest and rollout advance

**Grade: B−** — Feature-rich with genuine safety mechanics; `TEST_OTA` and webhook auth model are production footguns.

---

## 4. Database and storage choices

| Store | Purpose | Risk |
|-------|---------|------|
| **MongoDB** | Devices, users, certs, firmware releases, campaigns | Hard startup requirement (`MONGODB_URI`). Single logical source of truth; no replica config in app. |
| **Redis** | Provisioning tokens, recovery sessions, rate limits, IG polling queues, dedupe | Optional at runtime — falls back to in-memory token store and per-process rate limits. **Not safe for multi-instance** without Redis. Production Redis TLS check exists; mandatory prod Redis check is **commented out** in `validateConfig`. |
| **InfluxDB** | Device metrics, PKI audit chain, OTA telemetry, webhook audit, IG audit | **Hard startup requirement** — `INFLUXDB_TOKEN` missing → server refuses to start. TSDB treated as core dependency even for registration-only scenarios. |
| **Influx disk queue** | WAL for batched Influx writes | File-based with configurable `maxLinesPerFile`; worker failure can stall or lose buffered points. |
| **Local JSON** | `data/active-devices.json` via `LocalActiveDeviceStore` | Active device cache is **file-primary**; Redis active-device cache intentionally disabled in `deviceService.ts`. |
| **SQLite (legacy)** | Certificate store | Removed; `CAService` constructor still accepts `_dbPath` for backward compatibility. |

**Grade: C+** — Reasonable for a pilot stack; hard Influx coupling and Redis optional/multi-instance gap are architectural debt.

---

## 5. Configuration — env variable hell

**File:** `src/config/index.ts` (~1,031 lines, **107** `process.env` reads)

- Legacy aliases for the same concept (e.g. `MQTT_TLS_CA_PEM` / `MQTT_TLS_CA_CERT` / `MQTT_TLS_CA_BASE64`; OTA Ed25519 key PEM/base64/path variants)
- **Disk I/O at load time** — `writeProvisioningRootCaFromEnv()` writes Root CA material from base64 env vars
- **`InstagramPollingConfig`** — 17+ tuning knobs (priority intervals, backoff, caps, fair rotation, fetch budgets); most default to `0` (disabled)
- Commented production guard for `REDIS_URL` (~line 997)
- Swagger + webhook + OTA + social configs all loaded in one module

**Grade: D** — Operable with `.env` discipline; hazardous without a config matrix doc and CI env validation.

---

## 6. Testing — thin for size, not absent

### Inventory (July 2026)

| Category | Count |
|----------|-------|
| `src/**/*.ts` | ~140 files |
| Unit test files | **43** (`tests/unit/**/*.test.ts`) |
| Integration tests | **1** (`tests/integration/connections.ts`) |

### What is tested

- OTA service, rollout scheduler, rollout math, OTA webhooks, OTA routes (mocked mTLS)
- Provisioning routes (onboarding auth, sign-csr token missing)
- Lifecycle routes (reissue validation, Redis unavailable)
- Recovery session service, recovery routes
- Influx bucket routing, disk queue
- Webhooks (GMB publish, dedupe, enrichment worker)
- Stimulate/IG unit tests, campaign schedule, MQTT ingress router

### What is **not** tested (critical gaps)

| Component | Gap |
|-----------|-----|
| `app.ts` / `StatsMqttLite` | No unit or integration tests |
| `mtlsAuth.ts` | No dedicated tests; only mocked in `otaRoutes.test.ts` |
| `caService.ts` | No unit tests for signCSR, fingerprint storage, slot logic |
| Full CSR → cert → mTLS request flow | No end-to-end crypto test |
| `ensureDeviceProvisioned()` | No tests for fail-open when `caService` null |
| Multi-instance Redis/rate-limit behavior | Untested |

**Grade: D+** — Better than “five test files,” still far below what PKI + OTA + fleet scale demand.

---

## 7. Directory structure and file gravity

```
src/
├── app.ts                     ← 2,228 lines — god class
├── config/index.ts            ← 1,031 lines — env + validation + disk writes
├── routes/                    ← 11 route modules
│   └── provisioningRoutes.ts  ← ~1,355 lines
├── services/                  ← 35 top-level service files
│   ├── otaService.ts          ← 1,843 lines
│   ├── instagramService.ts    ← 1,894 lines (entire IG subsystem in one file)
│   ├── caService.ts           ← 808 lines
│   └── googleBusiness/        ← OAuth + API client
├── middleware/                ← 5 files (clean)
├── models/                    ← 15 files (14 domain models + index)
├── storage/influx/repositories/ ← 7 repo files (+ BaseInfluxRepo)
├── webhooks/                  ← 14 files (GMB Pub/Sub pipeline)
├── utils/                     ← 18 files
├── jobs/rolloutScheduler.ts
└── notifications/slackOta.ts

stimulate/                     ← TEMP in-process synthetic IG/GMB ramps (still committed)
tests/unit/                    ← 43 test files
tests/integration/             ← 1 file
```

**35 services** for this footprint is high. Many are thin wrappers instantiated manually in `app.ts`. The proliferation is a symptom of missing composition root / DI, not organic domain boundaries.

**Grade: C** — Navigable folders; file-size and coupling are the problem.

---

## 8. Feature focus — scope creep

### Stated core (from README / pilot docs)

MQTT messaging, device provisioning, OTA, fleet stats.

### Also in the same process

| Subsystem | Approx. footprint | Notes |
|-----------|-------------------|-------|
| Instagram polling | `instagramService.ts` ~1,894 lines + config knobs + Influx audit repo | Dual scheduler, Redis Lua, serverless bridge, circuit breaker |
| GMB webhooks | 14 files under `src/webhooks/` | Pub/Sub verify, dedupe, enrichment worker, screen publish |
| Campaigns / promotions | `promotionService`, `campaignSchedule`, models | Shopify/Square-style offer delivery over MQTT |
| Stimulate | `stimulate/` + `stimulateService.ts` | Synthetic follower/review ramps; README says TEMP |
| Google Business OAuth | `googleBusiness/` + connect pull | Profile sync, token refresh |
| Dashboard / connections API | `dashboardRoutes`, `connectionsRoutes` | User integration management |

Instagram + GMB + webhooks + campaigns likely account for **40%+ of `src/` line count**. None of this is wrong as product features — it is wrong as **one monolithic MQTT server lifecycle** without service boundaries.

**Grade: D** — Pilot feature accretion without extraction strategy.

---

## 9. Operational and compliance notes

- **Pilot exceptions documented elsewhere:** `docs/PILOT_V1_EXCEPTIONS.md`, `docs/COMPLIANCE.md`, `docs/SECURITY_AUDIT_CHECKLIST.md` — read those for intentional deferrals (CRL, multi-instance rate limits, etc.).
- **Bun-specific guidance:** `docs/BUN_SECURITY.md`
- **Capacity planning:** `docs/CAPACITY.md` — cross-check before fleet-scale reconnect scenarios.

---

## 10. Verdict table

| Dimension | Grade | Why |
|-----------|-------|-----|
| **Security fundamentals** | B− | mTLS binding and audit chain are real. Default JWT secret, caService fail-open, reissue/recovery path, admin auth model, and webhook secrets are liabilities. |
| **Architecture** | D | 2,228-line god class, 35 manually wired services, no DI, feature entanglement. |
| **Testing** | D+ | 43 unit tests exist (OTA/routes/webhooks covered); app.ts, mtlsAuth, caService, and E2E PKI flows untested. |
| **Config complexity** | D | 107 env reads, legacy aliases, load-time disk writes, commented prod checks. |
| **OTA design** | B− | Staged rollout + abort logic + tests; TEST_OTA and webhook auth are footguns. |
| **Feature focus** | D | IG + GMB + campaigns + stimulate in one broker process — scope creep. |
| **Code quality** | C | No obvious import-cycle catastrophe; individual files are too large and too coupled. |

---

## 11. Bottom line

**Ship for a controlled pilot?** Yes — if env secrets are locked down, `TEST_OTA` is false, Redis is mandatory in prod, reverse proxy strips dangerous headers, and recovery tokens are short-lived.

**Ship as a long-lived platform without changes?** No.

**Do first (priority order):**

1. Remove or gate `TEST_OTA` behind explicit dev-only env + startup fatal in production.
2. Fail closed when `requireMtlsForRegistration` is true but `caService` is null.
3. Add tests for `mtlsAuth.ts` fingerprint match/mismatch and `caService.signCSR` validation paths.
4. Extract Instagram polling and GMB webhooks to separate workers/services with defined MQTT/HTTP contracts.
5. Split `StatsMqttLite` — at minimum: `MqttLifecycle`, `HttpBootstrap`, `OtaCoordinator` as composable modules with unchanged behavior.
6. Replace admin domain-list auth with proper RBAC or IdP groups before fleet OTA admin exposure.

The PKI/mTLS layer is the best-engineered part of this codebase. Protect it, test it, and stop burying it under unrelated social metrics features in the same 2,228-line file.

---

*This report reflects the repository state as of July 2026. Re-run line counts and test inventory after major refactors.*

---

## Appendix A — In-process feature env gates

Subsystems stay in one deployable but are gated by environment. See [CONFIG_MATRIX.md](CONFIG_MATRIX.md) for the full matrix.

| Subsystem | Primary gate | Disabled when |
|-----------|--------------|---------------|
| Provisioning / PKI | `PROVISIONING_ENABLED` (default on) | `PROVISIONING_ENABLED=false` |
| Instagram poller | Redis connected + Lua scripts loaded | Redis down or poller init skipped |
| OTA | `OTA_ENABLED=true` | unset / false |
| GMB webhooks | `WEBHOOK_ENABLED` + Pub/Sub audience in prod | `WEBHOOK_ENABLED=false` or missing audience |
| Stimulate (TEMP) | `STIMULATE_DEVICE` set | unset |
| TEST OTA fan-out | `TEST_OTA=true` | blocked in production (`assertTestOtaAllowed`) |

Startup logs a subsystem summary after Phase 2 init (`📋 Enabled subsystems`).

---

## Appendix B — Explicit deferrals (July 2026 improvement plan)

| Item | Status | Reason |
|------|--------|--------|
| CRL / OCSP | Deferred | [POST_PILOT_ROADMAP.md](POST_PILOT_ROADMAP.md) / pilot exceptions |
| Admin IdP / RBAC | Deferred | Product IdP choice pending; domain-list auth remains |
| Microservice extraction | Declined | In-process modularization (`src/bootstrap/`) chosen instead |
| Implicit OTA success removal | Document-only | Business logic — see [SERVER_OTA_REQUIREMENTS.md](SERVER_OTA_REQUIREMENTS.md) |
| Remove `_dbPath` from CAService | Deferred | Breaking constructor for negligible gain |
| Optional InfluxDB at startup | Deferred | Operational model change |
| Remove `stimulate/` | Deferred | Product decision |

---

## Appendix C — Post-plan refactor notes (July 2026)

Improvements applied without changing valid production business flows:

- Security: prod JWT/Redis/TEST_OTA guards, caService fail-closed, mTLS DB blip → 503, XFF download URL fix
- Tests: `mtlsAuth`, `caService`, `deviceProvisioningGate`, E2E harness (`bun run test:e2e`)
- Modularization: `src/bootstrap/` (device registration, OTA coordinator, HTTP routes, Phase 2 init)
- OTA registration defer queue: `OTA_REGISTRATION_DEFER_CONCURRENCY` (default 10)
- Config: domain modules under `src/config/`, `docs/CONFIG_MATRIX.md`, `bun scripts/validate-env.ts`

### Appendix C+ — Production hardening follow-up (2026-07-27)

- Deferred queue: re-arm, one failure retry, coordinator-not-ready fails (not silent success), drain log contract (`pending`/`processed`/`failed`/`skippedStale`/`rearmed`); rollback `DEFERRED_WORK_REARM=false`
- Misconfig: `GMB_PUBSUB_SKIP_AUTH_VERIFY` fail-fast in prod; CI fixture `tests/fixtures/prod-env.env`
- OTA webhook: constant-time bearer compare + Redis dedupe on release ingest
- Cert lookup: slot query aligned with mTLS; DB blip ≠ unprovisioned
- GMB dedupe fail-open retained as **pilot risk** with `dedupe_fail_open` log field
- In-memory deferred queue documented as pilot limit; runbooks under `docs/runbooks/`
- E2E: storm + misconfig + mTLS failure paths; CI runs `test:e2e` + validate-env fixture
- Phase 0 decisions: [docs/PRODUCTION_HARDENING_PHASE0.md](PRODUCTION_HARDENING_PHASE0.md)
