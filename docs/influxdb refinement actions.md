# InfluxDB Refinement Actions

## Phase 1 — Dual-Bucket Split

### Config (`src/config/index.ts`)
- Added `complianceBucket` field to `InfluxDBConfig` (string, default: `pki_compliance`)
- Env var `INFLUXDB_COMPLIANCE_BUCKET` (default applied inside `loadConfig()`)
- `validateConfig` rejects empty `complianceBucket`
- `.env.example` updated
- Startup log and `app.ts` error message updated  

### InfluxService (`src/services/influxService.ts`)
- Exported const-object type `BucketTarget` with `METRICS` / `COMPLIANCE`
- Dual `WriteApi`: `metricsWriteApi` + `complianceWriteApi`
- Dual disk queues: `metricsDiskQueue` + `complianceDiskQueue` (paths `{diskQueuePath}.metrics` / `.compliance`)
- Compliance disk queue always `syncOnAppend: true`, compliance WriteApi uses `maxRetries: 5`
- `resolveBucket(target)` returns correct bucket name per `BucketTarget`
- `submitPoint(point, target, flushImmediately?)` — 3-arg signature routes to correct WriteApi
- `writeApiFor(target)` / `diskQueueFor(target)` helpers
- `flushWrites()` flushes both WriteApis; `close()` closes both
- `healthCheck()` verifies both buckets via `verifyBucket(bucketName, label)` helper
- New methods: `writeOtaReleaseEntry(entry)`, `queryOtaReleaseLeaves(range)` — write/query `ota_release_log` measurement in compliance bucket
- All 13 metrics write methods → `BucketTarget.METRICS`; 3 compliance write methods (`writeAuditEvent`, `writeTransparencyEntry`, `writeOtaReleaseEntry`) → `BucketTarget.COMPLIANCE`
- All Flux queries specify bucket via `resolveBucket(target)` (3 metrics, 5 compliance — includes `queryOtaReleaseLeaves`)
- One `QueryApi` (org-scoped)

### Tests
- `tests/unit/config/influxConfig.test.ts` — 3 new tests for complianceBucket (default, custom env, empty guard)
- `tests/unit/services/influxServiceBucketRouting.test.ts` — 7 routing tests covering both targets, all 15 write/query methods, flush, close, healthCheck

### Docs
- `docs/COMPLIANCE.md` — dual-bucket architecture table, migration Flux commands, retention tiers, architecture diagram

## Phase 2 — OTA PKI Compliance

### Audit Events (`src/services/auditService.ts`)
- New `AuditEventType` values: `OTA_RELEASE_VALIDATED`, `OTA_RELEASE_REVOKED`, `OTA_COMMAND_ISSUED`, `OTA_COMMAND_DELIVERED`, `OTA_DEVICE_STATE_CHANGED`, `OTA_DEVICE_BLOCKED`, `OTA_SIGNING_KEY_LOADED`, `OTA_SIGNING_KEY_ROTATED`, `OTA_SIGNING_KEY_COMPROMISE`, `OTA_RELEASE_LOG_ENTRY`

### OTA Service (`src/services/otaService.ts`)
- `computeSigningKeyFingerprint(publicKeyPem)` — SHA-256 of DER-decoded SPKI, hex-encoded
- `OtaActiveRelease.keyFingerprint` field
- `OtaUpdateOffer.keyFingerprint` field
- Admin finalize route logs `OTA_RELEASE_VALIDATED` on success, failure event with `code`/`error`
- `ingestRelease` logs `OTA_RELEASE_VALIDATED` with `keyFingerprint` on success
- `resolveUpdate` logs `OTA_CHECK_OFFERED` on match, `OTA_CHECK_NO_UPDATE` on no match
- `publishUpdateToDevice` / `publishBroadcastUpdate` log `OTA_COMMAND_ISSUED` (includes `sha256`, `keyFingerprint`, `version`, `deviceId` where available)
- `onDelivered` callback logs `OTA_COMMAND_DELIVERED` after `markDeviceDelivered`
- `updateOtaState` logs `OTA_DEVICE_STATE_CHANGED`
- `recordRollbackFailure` logs `OTA_DEVICE_BLOCKED` when threshold hit
- `getActiveReleaseMeta()` — reads active release from **Redis** via `OtaRedisState.getActiveRelease()`, returns `{ sha256, keyFingerprint, signature }`
- `OtaEventHandler.handle` loads `Device.findOne(...).select({ firmwareVersion, otaState }).lean()`, passes `sha256`/`keyFingerprint`/`previousFirmwareVersion` to audit

### OtaReleaseLog (`src/services/otaReleaseLog.ts`)
- Separate measurement `ota_release_log` in `pki_compliance` bucket (independent Merkle tree, not sharing with cert CT)
- Class `OtaReleaseLog` with InfluxDB-backed Merkle chain
- `initialize()` — loads existing leaves from InfluxDB
- `addEntry(version, sha256, objectKey, keyFingerprint?, releasedAt?)` — inserts leaf, returns entry
- `getEntryCount()` / `getCurrentRootHash()` — Merkle tree query
- Wired: `createOtaReleaseLog()` + `initialize()` called from `app.ts` `initializeOtaServices()`; `addEntry` called from `ingestRelease` and admin promote route

### OtaSigningKeyService (`src/services/otaSigningKeyService.ts`)
- `initOtaSigningKeyAudit(publicKeyPem, source)` — called from `app.ts` `initializeOtaServices()`, logs initial `OTA_SIGNING_KEY_LOADED` events with `keyFingerprint` and `source` (`'env'` | `'file'`)

### App Wiring (`src/app.ts`)
- `initializeOtaServices()` calls `initOtaSigningKeyAudit(publicKeyPem, source)` — logs signing key fingerprint at startup
- `initializeOtaServices()` also calls `createOtaReleaseLog()` + `initialize()` — release transparency log active

## Fixes

### Test Interference
- `tests/unit/services/influxServiceBucketRouting.test.ts` — removed module-level `jest.mock('@/services/influxDiskQueue')` and `jest.mock('@/utils/logger')` that were leaking globally in bun test and breaking config + disk queue tests when run together
- `tests/unit/services/otaEventHandler.test.ts` — updated `Device.findOne` mock to support `.select().lean()` chaining, added `getActiveReleaseMeta` mock method

### Results
- TypeScript: `tsc --noEmit` passes clean
- Tests: 134 pass, 0 fail (30 files)

## Remaining Work

### Code Gaps
1. **`OTA_RELEASE_REVOKED`**: Enum exists but never emitted. No fleet-wide revocation route exists; per-device blocking via `OTA_DEVICE_BLOCKED` is the current substitute. Add admin revoke route when required.
2. **`OTA_SIGNING_KEY_ROTATED` / `COMPROMISE`**: Enum exists. Deferred — no admin rotation/compromise endpoints yet.

### Optional Tests (lower priority)
1. `ingestRelease` → `ota_release_log` `addEntry` assertion (currently `getOtaReleaseLog` mocked to null)
2. Integration-style test: `ota_success` audit reads fingerprint from real Redis path
3. Admin promote → `getOtaReleaseLog()?.addEntry(...)` assertion

## Ops Actions (Pre-Deploy)
1. Create `pki_compliance` bucket in InfluxDB with 1yr+ retention
2. Run Flux migration to copy existing `pki_audit` / `ct_log` to `pki_compliance` (see `docs/COMPLIANCE.md`)
3. Set `metrics` bucket retention to 30 days
4. Deploy code
5. Verify health check confirms both buckets
