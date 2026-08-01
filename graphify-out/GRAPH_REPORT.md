# Graph Report - proofmqtt  (2026-08-01)

## Corpus Check
- 397 files · ~211,227 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 3427 nodes · 6524 edges · 242 communities (186 shown, 56 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 28 edges (avg confidence: 0.6)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `3a107f9e`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 11
- Community 12
- Community 13
- Community 14
- Community 15
- Community 16
- Community 17
- Community 18
- Community 19
- Community 20
- Community 21
- Community 22
- Community 23
- Community 24
- Community 25
- Community 26
- Community 27
- Community 28
- Community 29
- Community 30
- Community 31
- Community 32
- Community 33
- Community 34
- Community 36
- Community 37
- Community 38
- Community 39
- Community 40
- Community 41
- Community 42
- Community 43
- Community 44
- Community 46
- Community 47
- Community 48
- Community 49
- Community 50
- Community 51
- Community 52
- Community 53
- Community 54
- Community 55
- Community 56
- Community 57
- Community 58
- Community 59
- Community 60
- Community 61
- Community 62
- Community 63
- Community 64
- Community 65
- Community 66
- Community 67
- Community 68
- Community 69
- Community 70
- Community 71
- Community 72
- Community 73
- Community 74
- Community 75
- Community 76
- Community 77
- Community 78
- Community 79
- Community 80
- Community 81
- Community 82
- Community 83
- Community 84
- Community 85
- Community 86
- Community 87
- Community 88
- Community 89
- Community 90
- Community 91
- Community 92
- Community 93
- Community 94
- Community 95
- Community 96
- Community 97
- Community 99
- Community 100
- Community 101
- Community 102
- Community 103
- Community 104
- Community 105
- Community 106
- Community 107
- Community 108
- Community 109
- Community 110
- Community 111
- Community 112
- Community 113
- Community 114
- Community 115
- Community 116
- Community 117
- Community 118
- Community 119
- Community 120
- Community 122
- Community 123
- Community 125
- Community 126
- Community 127
- Community 128
- Community 129
- Community 130
- Community 131
- Community 132
- chainValidator.ts
- Community 134
- Community 135
- Community 136
- Community 137
- Community 138
- Community 139
- Community 140
- Community 141
- Community 143
- Community 144
- campaignSchedule.ts
- Community 146
- Community 148
- husky.sh
- post-applypatch
- post-checkout
- post-commit
- sign-firmware.ts
- print-railway-broker-env.sh
- OtaTelemetryRepo
- Community 156
- influxConfig.test.ts
- applypatch-msg
- commit-msg
- husky.sh
- Community 161
- Community 162
- Community 163
- Community 164
- post-commit
- post-merge
- post-rewrite
- pre-applypatch
- pre-auto-gc
- pre-commit
- shouldSkipForStimulate
- pre-push
- pre-merge-commit
- pre-push
- pre-push
- pre-rebase
- prepare-commit-msg
- swagger-jsdoc
- flash-baseline.sh
- generate-keys.sh
- sign-firmware.sh
- generate-broker-cert.sh
- {
  verifyShopifyWebhook,
  verifySquareWebhook,
  isSquarePaymentEvent,
  isSquareInvoiceEvent,
  isSquareAppWebhookEvent,
  parseSquareWebhookEnvelope,
  getIdString,
  buildReviewFromNotification,
  isGmbTestNotification,
  resolveGmbAccountResourceName,
  resolveGmbLocationResourceName,
  resolveGmbReviewPayload,
  resolveGmbReviewResourceName
}
- recoveryRoutes.ts
- 📋 Your Requirements
- dashboardRoutes.ts
- transparencyLog.ts
- express-rate-limit
- google-auth-library
- helmet
- @influxdata/influxdb-client
- jsonwebtoken
- mongoose
- node-forge
- prom-client
- uuid
- husky
- winston
- @types/node
- index.ts
- E2E HTTP flow tests
- Redis down
- 1. Architecture
- httpProbe.ts
- push-update.ts
- PkiAuditRepo
- post-checkout
- DeviceACL.ts
- LocalTtlCache
- mongoDriverTimeouts
- 1. Coverage gaps — `helpers.ts` (PARTIAL: 2 tests)
- mqttConfig.ts
- provisioningConfig.ts
- localCaches — Test Suite Gap Report
- 1. Coverage gaps
- SessionService
- publishGmbScreen.ts
- influxService — Test Suite Gap Report
- AppConfig
- LocalDeviceBackoff
- 1. Coverage gaps
- 🧪 Test It Works
- otaDefaults.ts
- otaSigningKeyService — Test Suite Gap Report
- 🧪 Testing Your CSR
- 🔍 Server Implementation Details
- Deferred queue backlog / stale drops
- OTA webhook reject
- 3. OTA subsystem — ambitious and footgun-prone
- CtLogRepo
- 1. Coverage gaps
- chainValidator.ts
- gmb-pubsub.ts
- 1. Coverage gaps
- 1. Coverage gaps
- 1. Coverage gaps
- webhookMetrics — Test Suite Gap Report
- .sync
- LocalTtlCache
- GmbMilestoneRepo
- IgMetricsRepo
- node-forge
- swagger-ui-express
- @types/supertest

## God Nodes (most connected - your core abstractions)
1. `logger` - 84 edges
2. `InfluxService` - 59 edges
3. `StatsMqttLite` - 58 edges
4. `Device` - 58 edges
5. `MqttClientManager` - 49 edges
6. `OtaService` - 47 edges
7. `BootstrapHost` - 46 edges
8. `getIgDeviceRuntimeCache()` - 39 edges
9. `CAService` - 37 edges
10. `getRedisService()` - 37 edges

## Surprising Connections (you probably didn't know these)
- `ensureStimGmbLock()` --calls--> `getLocalStimLock()`  [EXTRACTED]
  stimulate/gmbRunner.ts → src/services/localCaches.ts
- `releaseStimGmbLock()` --calls--> `getLocalStimLock()`  [EXTRACTED]
  stimulate/gmbRunner.ts → src/services/localCaches.ts
- `setupSwaggerUi()` --references--> `express`  [EXTRACTED]
  src/config/swagger.ts → package.json
- `main()` --calls--> `loadConfig()`  [EXTRACTED]
  scripts/ota/upload-firmware-oci.ts → src/config/index.ts
- `main()` --calls--> `createFirmwareStorageService()`  [EXTRACTED]
  scripts/ota/upload-firmware-oci.ts → src/services/firmwareStorageService.ts

## Import Cycles
- None detected.

## Communities (242 total, 56 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.05
Nodes (46): abandonAttentionCorrelation(), applyInstagramServerlessDeviceOutcome(), areInstagramPollingScriptsLoaded(), atomicBackoffCheckAndRecordLua, atomicFetchBudgetTryLua, atomicPriorityReadAndPruneLua, AttentionE2eLatencySnapshot, buildLatencySnapshot() (+38 more)

### Community 1 - "Community 1"
Cohesion: 0.15
Nodes (19): check(), main(), Result, results, smokeProvAndSync(), REDIS_KEYS, ensureFreshInstagramAccessToken(), InstagramTokenContext (+11 more)

### Community 2 - "Community 2"
Cohesion: 0.20
Nodes (5): findActiveCertForSlots(), DeviceCertificate, DeviceCertificateSlot, IDeviceCertificate, CAService

### Community 4 - "Community 4"
Cohesion: 0.05
Nodes (39): 1.10 Webhook Deduplication (redisDedupe.ts), 1.11 GMB Review Cache (gmbReviewCache.ts), 1.12 CSR Rate Limiter (csrRateLimiter.ts / csrRateLimitLua.ts), 1.13 Recovery Sessions (recoverySessionService.ts), 1.14 OTA State (otaService.ts — OtaRedisState), 1.15 OTA Rollout Scheduler (rolloutScheduler.ts), 1.16 Stimulate Service (stimulateService.ts), 1.17 Connect Refresh Coordinator (connectRefreshCoordinator.ts) (+31 more)

### Community 5 - "Community 5"
Cohesion: 0.08
Nodes (24): 1.10 `recordOtaFailure` / `recordRollbackFailure` — PARTIAL (P0 classify/abort closed), 1.11 `recordOtaSuccess` — UNTESTED, 1.12 `maybeRecordImplicitOtaSuccess` — UNTESTED, 1.13 `updateOtaState` / `updateFirmwareVersion` — UNTESTED, 1.14 `updateOtaState`/`markDeviceDelivered`/`getStableRelease`/`getActiveReleaseMeta`/`isValidObjectId` — UNTESTED (trivial, low priority), 1.1 `resolveUpdate` — PARTIAL, 1.2 `ingestRelease` — PARTIAL (P0 error matrix closed), 1.3 `advanceRollout` — PARTIAL (P0 step logic closed) (+16 more)

### Community 6 - "Community 6"
Cohesion: 0.08
Nodes (37): FirmwareReleaseSchema, FirmwareReleaseStatus, FirmwareRolloutSchema, FirmwareRolloutStrategy, IFirmwareRollout, createOtaAdminRoutes(), requireAdminAuth(), ObjectHeadResult (+29 more)

### Community 7 - "Community 7"
Cohesion: 0.06
Nodes (34): 📚 Additional Resources, After (Redis Cloud):, Before (Local):, Best Practices, Check Logs, Connection Flow, 🔧 Connection Methods, Environment Variable: (+26 more)

### Community 8 - "Community 8"
Cohesion: 0.24
Nodes (5): BaseInfluxRepo, MqttDeliveryRepo, PkiAuditRepo, BucketTarget, mockConfig

### Community 11 - "Community 11"
Cohesion: 0.06
Nodes (34): 1.1 Webhook Routes (`/api/webhooks/*`), 1.2 Promotion Routes (`/api/v1/promotions/*`), 1.3 Connections Routes (`/api/v1/connections/*`), 2.1 Device OTA Routes (`/api/v1/ota/*`), 2.2 Admin OTA Routes (`/api/v1/admin/ota/*`), 3.1 Provisioning Routes (`/api/v1/onboarding/*`), 3.2 Config Routes (`/api/v1/config/*`), 3.3 Lifecycle Routes (`/api/v1/lifecycle/*`) (+26 more)

### Community 12 - "Community 12"
Cohesion: 0.07
Nodes (18): StatsMqttLite, DeferredDeviceWorkQueue, DeferredDrainResult, DeferredWorkItem, isDeferredWorkRearmEnabled(), resolveOtaRegistrationDeferConcurrency(), BufferedMqttMessage, flushMessageBuffer() (+10 more)

### Community 13 - "Community 13"
Cohesion: 0.12
Nodes (17): Architecture (what you are testing), ESP32 OTA End-to-End Manual Test Guide, Files in this repo, MQTT topics (must match server `MQTT_TOPIC_ROOT`), OTA command payload (server → device), Quick reference (3 terminals), Related docs, Short checklist (9 steps) (+9 more)

### Community 14 - "Community 14"
Cohesion: 0.06
Nodes (33): compression, cors, dotenv, express, express-rate-limit, google-auth-library, helmet, @influxdata/influxdb-client (+25 more)

### Community 15 - "Community 15"
Cohesion: 0.05
Nodes (38): 0. CONTEXT & PROJECT UNDERSTANDING, 1.1 H-1: mTLS Fingerprint Binding at HTTP Edge, 1.2 H-2: Admin JWT Scope Hardening (Interim → Permanent), 1.3 DEV-1: Keep Dev OTA Route — Rename for Pilot v1, 1.4 M-1: Remove WebSocket Server Completely, 1.5 M-2: Trim Health Endpoint Information Disclosure, 1.6 M-3: CORS Origin Restriction, 1.7 M-4: CSR Rate Limiter — Fallback to Local Cache (+30 more)

### Community 16 - "Community 16"
Cohesion: 0.05
Nodes (42): 10. Daily Metrics — POS Order Tracking, 11. Connect Refresh Coordinator, 12. GMB Review Cache, 1. OtaRedisState — OTA Coordination, 2. Instagram Polling & Lua Scripts, 3. RecoverySessionService — Factory Reset Sessions, 4. PromotionService — Campaign Cache, 5. BrandCanvasService — Ad Cache (+34 more)

### Community 19 - "Community 19"
Cohesion: 0.06
Nodes (30): 1.1 `igPollMetricsInc` / `getInstagramPollingMetricsSnapshot` — UNTESTED, 1.2 Correlation registry (`registerAttentionCorrelationStart` / `abandonAttentionCorrelation` / `observeAttentionFetchLatencyMs`) — UNTESTED, 1.3 Latency ring (`recordLatencySample` / `buildLatencySnapshot`) — UNTESTED, 1. Coverage gaps — polling metrics & in-process state (L1–143), 2.1 Lua script strings — UNTESTED (unit-level), 2.2 `loadInstagramPollingScripts` / `areInstagramPollingScriptsLoaded` / `resetInstagramPollingScriptsCache` — UNTESTED, 2.3 `evalAtomicPriorityReadAndPruneEvalSha` + `evalShaWithFallback` — UNTESTED, 2. Coverage gaps — Lua atomics + EVALSHA helpers (L184–293) (+22 more)

### Community 20 - "Community 20"
Cohesion: 0.12
Nodes (22): productionMode, AppEnvConfig, AppFeaturesConfig, AuthConfig, HttpConfig, loadConfig(), loadOciCredentialsFromEnv(), loadOtaSigningPublicKeyPem() (+14 more)

### Community 22 - "Community 22"
Cohesion: 0.07
Nodes (30): bun-types, ES2020, stimulate/**/*, **/*.test.ts, compilerOptions, allowSyntheticDefaultImports, baseUrl, declaration (+22 more)

### Community 23 - "Community 23"
Cohesion: 0.05
Nodes (36): Close-out Checklist, Completed: P3.1 - Fleet Capacity Documentation, Completed: P3.2 - Prometheus Alerts, Completed: P3.3 - Global Rate Limiting, Completed: P3.4 - Compliance Documentation, Completed: P3.7 - Security Audit Checklist, Current (2026-07-02), Detailed Roadmap (+28 more)

### Community 24 - "Community 24"
Cohesion: 0.09
Nodes (22): 1.10 `queryMongoDeviceState` — UNTESTED, 1.11 Singleton — UNTESTED, 1.1 Basic accessors — UNTESTED, 1.2 `set` — PARTIAL, 1.3 Followers / GMB / pub / power-save / OTA — UNTESTED, 1.4 Dirty tracking — UNTESTED, 1.5 `hydrateFromHashFields` — PARTIAL (only gmb_profile_id + ota_status), 1.6 `runtimeDataToHash` — UNTESTED (+14 more)

### Community 25 - "Community 25"
Cohesion: 0.10
Nodes (20): Attention polling — implementation status, Code references, Code references, Dual schedulers — priority and background (both implemented), Health and readiness, Intended flow (device scan / NFC), Phase A — Operations and configuration hardening, Phase B — Attention / priority signals (+12 more)

### Community 26 - "Community 26"
Cohesion: 0.12
Nodes (27): buildObjectKey(), buildParUrl(), { common, objectstorage }, createOciClient(), createOciDownloadUrl(), hasOciEnvCredentials(), normalizePem(), OTA_PRESIGNED_TTL_SEC (+19 more)

### Community 27 - "Community 27"
Cohesion: 0.10
Nodes (19): 1. Added `isRedisConfigured()` Method, 2. Added Configuration Check in `connect()` Method, 3. Added Configuration Check in `app.ts`, 4. Fixed `disconnect()` Error Handling, 5. Updated Config Validation, 🎯 Behavior After Fix, 📋 Environment Variables, 🔍 Files Modified (+11 more)

### Community 28 - "Community 28"
Cohesion: 0.07
Nodes (28): Actual Retention Mechanism, Appendices, Appendix A: Retention Policy History, Appendix B: Cost Tracking, Application Configuration, Architecture, Boot-time retention verification (recommended), Compliance Considerations (+20 more)

### Community 29 - "Community 29"
Cohesion: 0.10
Nodes (19): App Wiring (`src/app.ts`), Audit Events (`src/services/auditService.ts`), Code Gaps, Config (`src/config/index.ts`), Docs, Fixes, InfluxDB Refinement Actions, InfluxService (`src/services/influxService.ts`) (+11 more)

### Community 30 - "Community 30"
Cohesion: 0.17
Nodes (7): Device, IDevice, FirmwareRelease, IFirmwareRelease, syncHashFieldsImmediate(), OtaService, isVersionGreater()

### Community 31 - "Community 31"
Cohesion: 0.24
Nodes (17): appClientDir, backupIfExists(), caConfig(), caStoragePath, cmdAppClient(), cmdInitCa(), cmdPrintAppEnv(), cmdRotate() (+9 more)

### Community 32 - "Community 32"
Cohesion: 0.12
Nodes (17): Admin API (Bearer user JWT), CI webhook — automated release + staged rollout, Device HTTP — `GET /api/v1/ota/download/:version` (proxy mode, optional), Device HTTP — `POST /api/v1/ota/report` (optional fallback), Enable OTA, Finalize validation (server), MQTT — device → server telemetry (legacy, non-pilot), MQTT — server → device commands (+9 more)

### Community 33 - "Community 33"
Cohesion: 0.11
Nodes (18): 1. Check Health, 2. Publish MQTT Message, ⚡ 30-Second Setup, 3. Subscribe with Mosquitto, 4. Register a Device, 5. Get All Devices, Can't connect to MQTT broker?, 📂 Check Your Data (+10 more)

### Community 34 - "Community 34"
Cohesion: 0.17
Nodes (12): Admin OTA (interim → planned), Attack surface (production), Change log, Controls verified (positive), Executive summary, POS / integrations webhooks (production today), Production OTA (target state — already implemented except dev route), proofmqtt Security Assessment (+4 more)

### Community 36 - "Community 36"
Cohesion: 0.10
Nodes (11): BudgetTracker, consumeFetchBudget(), DeviceBackoff, FairOffset, FetchDedupe, LocalBudgetTracker, LocalDeviceBackoff, LocalFairOffset (+3 more)

### Community 37 - "Community 37"
Cohesion: 0.15
Nodes (17): clearStimCache(), key(), readStimCache(), StimCacheEntry, store, writeStimCache(), ensureStimGmbLock(), releaseStimGmbLock() (+9 more)

### Community 38 - "Community 38"
Cohesion: 0.09
Nodes (22): 1.1 Remove Committed Private Keys from Repo, 1.2 Update .env.example with Admin Auth, 1. Immediate (P1 Priority), 2.1 Migrate Runtime to Bun, 2.2 Remove Render Configuration, 2.3 Add ESLint + Prettier, 2. Medium Priority (2-3 days), 3.1 Core Infrastructure (+14 more)

### Community 39 - "Community 39"
Cohesion: 0.10
Nodes (6): flattenLegacyJson(), hydrateGmbReviewCountFromRedis(), IgDeviceRuntimeCacheImpl, markDeviceHashInactive(), queryMongoDeviceState(), readFollowerCountForRepublish()

### Community 40 - "Community 40"
Cohesion: 0.17
Nodes (17): buildInstagramScreenPayload(), BuildScreenEnvelopeOpts, CelebrationState, CelebrationType, GmbReviewItem, GmbScreenPayloadInput, instagramFollowerMetrics(), InstagramScreenPayloadInput (+9 more)

### Community 41 - "Community 41"
Cohesion: 0.18
Nodes (16): CampaignSchema, CampaignStatus, DiscountType, ICampaign, ScheduleType, TargetType, isCampaignActive(), isDayOfWeekActive() (+8 more)

### Community 42 - "Community 42"
Cohesion: 0.12
Nodes (17): scripts, build, check, check:full, coverage, dev, format, lint (+9 more)

### Community 43 - "Community 43"
Cohesion: 0.18
Nodes (21): getClaimBaseUrl(), Campaign, getLocalPromoActiveCache(), getLocalPromoRotationCache(), asCampaignForSchedule(), buildCampaignPayload(), campaignSocialIdFilter(), fanoutPromotionToUserDevices() (+13 more)

### Community 44 - "Community 44"
Cohesion: 0.22
Nodes (3): chunk(), igPollMetricsInc(), InstagramPoller

### Community 46 - "Community 46"
Cohesion: 0.13
Nodes (14): **1\. Executive Summary & Design Goals**, **2\. Comprehensive Concept Verification Matrix**, **3.1 Dual-Path Trigger Engine**, **3.2 State Tracking Mechanics**, **3\. Core Subsystem Operations**, **4.1 Cooldown and Blacklist Management**, **4.2 Post-Update Safety Architecture**, **4.3 Handshake Reliability (QoS 1 Application Loop)** (+6 more)

### Community 47 - "Community 47"
Cohesion: 0.17
Nodes (16): checkLocalShortCircuit(), csrRateLimiter(), DEFAULT_CONFIG, incrementLocalCounter(), localCounters, RateLimitConfig, rejectRateLimited(), resetCsrLocalCounters() (+8 more)

### Community 48 - "Community 48"
Cohesion: 0.13
Nodes (14): **1\. Executive Summary & Design Goals**, **2\. Comprehensive Concept Verification Matrix**, **3.1 Dual-Path Trigger Engine**, **3.2 State Tracking Mechanics**, **3\. Core Subsystem Operations**, **4.1 Cooldown and Blacklist Management**, **4.2 Post-Update Safety Architecture**, **4.3 Handshake Reliability (QoS 1 Application Loop)** (+6 more)

### Community 49 - "Community 49"
Cohesion: 0.18
Nodes (4): InfluxDiskQueue, InfluxDiskQueueOptions, influxWriteErrorMessage(), isPermanentInfluxWriteError()

### Community 50 - "Community 50"
Cohesion: 0.20
Nodes (18): Ad, AdSchema, AdStatus, AdType, IAd, NOTE: This is a READ-ONLY model for mqtt-publisher-lite., buildBrandCanvasPayload(), CachedBrandCanvasDto (+10 more)

### Community 51 - "Community 51"
Cohesion: 0.20
Nodes (7): Cleanup checklist (after device test passes), Direct OCI URL (optional sanity check), Download URL for firmware developer, OTA dev download test (temporary), Re-upload firmware to dev bucket, What this does **not** do, What was added (dev only)

### Community 52 - "Community 52"
Cohesion: 0.15
Nodes (18): LoopState, parseGmbTarget(), parseIgTarget(), parseIntervalMs(), parsePlatforms(), parseStep(), refreshStimLock(), StartDeps (+10 more)

### Community 53 - "Community 53"
Cohesion: 0.08
Nodes (23): extends, ignorePatterns, dist/, node_modules/, parser, parserOptions, project, plugins (+15 more)

### Community 54 - "Community 54"
Cohesion: 0.16
Nodes (10): RolloutSchedulerHandle, FirmwareStorageService, metaValue(), OciFirmwareStorageService, isRetryableOciError(), mapOciError(), OciStorageError, OciStorageErrorCode (+2 more)

### Community 55 - "Community 55"
Cohesion: 0.10
Nodes (25): computeAudience(), main(), loadWebhookConfig(), WebhookDeviceTarget, captureRawBody, createWebhookRoutes(), extractBearerToken(), gmbLimiter (+17 more)

### Community 56 - "Community 56"
Cohesion: 0.18
Nodes (11): DailyMetricsRedisKeys, DateBucketResult, getDailyMetricsKeys(), getDateBucket(), getStartOfDayInTimezone(), getTimezoneOffsetMs(), priceToCents(), resolveMetricsTimezone() (+3 more)

### Community 58 - "Community 58"
Cohesion: 0.13
Nodes (11): DeviceOtaState, DeviceSchema, DeviceStatus, DeviceData, compareVersions(), baseDeviceData, mockDeviceFindOne, mockDeviceSave (+3 more)

### Community 59 - "Community 59"
Cohesion: 0.17
Nodes (3): LocalPromoRotationCache, LocalPublishHashCache, LocalStimLock

### Community 60 - "Community 60"
Cohesion: 0.33
Nodes (5): engines, bun, name, type, version

### Community 61 - "Community 61"
Cohesion: 0.22
Nodes (9): 🏗️ Architecture, 📊 Comparison with Full Version, 📚 Documentation, ✨ Features, 📄 License, 🚀 MQTT Publisher Lite, 🚂 Railway Deployment, 🤝 Support (+1 more)

### Community 62 - "Community 62"
Cohesion: 0.15
Nodes (4): ActiveDevice, ActiveDeviceCache, LocalActiveDeviceStore, LocalStoreFile

### Community 63 - "Community 63"
Cohesion: 0.06
Nodes (31): 10. Verdict table, 11. Bottom line, 1. Architecture, 2. Security — the good, the bad, the ugly, 3. OTA subsystem — ambitious and footgun-prone, 4. Database and storage choices, 5. Configuration — env variable hell, 6. Testing — thin for size, not absent (+23 more)

### Community 64 - "Community 64"
Cohesion: 0.24
Nodes (5): main(), OCI_PYTHON_SDK_CONNECTION_TIMEOUT, OCI_PYTHON_SDK_READ_TIMEOUT, instance.sh script, write_metadata()

### Community 65 - "Community 65"
Cohesion: 0.13
Nodes (6): ProvisioningConfig, ProvisioningService, ProvisioningTokenPayload, TokenValidationResult, getTokenStore(), mockTokenStore

### Community 66 - "Community 66"
Cohesion: 0.22
Nodes (9): App runtime & metrics, 🔧 Configuration, Core (MQTT & HTTP), Feature flags (all default `true`), Integrations, Legacy environment names (deprecated), MongoDB connection pool, MQTT TLS / mTLS (production) (+1 more)

### Community 67 - "Community 67"
Cohesion: 0.06
Nodes (18): getSwaggerSpec(), resetSwaggerSpecCache(), resolveApiGlobs(), setupSwaggerUi(), swaggerDefinition, correlationIdMiddleware(), httpRequestDuration, httpRequestsTotal (+10 more)

### Community 69 - "Community 69"
Cohesion: 0.19
Nodes (5): DeviceRecoveryJwtClaims, hashToken(), RecoverySessionError, RecoverySessionRedisState, RecoverySessionService

### Community 70 - "Community 70"
Cohesion: 0.10
Nodes (14): Dashboard → user, Device AP — `POST /api/recovery/restore`, Device → MQTT — `POST /api/v1/certificates/reissue`, Device recovery API (firmware contract), Environment, Errors (firmware handling), MQTT — register session (dashboard proxy only), OTA Download Endpoint (+6 more)

### Community 71 - "Community 71"
Cohesion: 0.06
Nodes (35): bun-types, eslint, husky, devDependencies, bun-types, eslint, husky, prettier (+27 more)

### Community 72 - "Community 72"
Cohesion: 0.25
Nodes (8): Broker config (Flow 1), 🧭 Device Lifecycle V5.0 (firmware contract), Firmware flow mapping (V5.0), Flow 2: Seamless Renewal (overlap, MQTT-validated), Flow 4: Factory reset recovery (JWT session + reissue), HTTP endpoints used by firmware, Initial enrollment (existing), mTLS identity for HTTP (proxy mode)

### Community 73 - "Community 73"
Cohesion: 0.14
Nodes (18): extractMtlsIdentityFromNativeTls(), extractMtlsIdentityFromProxy(), firstHeader(), MtlsCertSlot, MtlsIdentity, normalizeFingerprint(), normalizeForwardedPem(), parseCommonNameFromX509Subject() (+10 more)

### Community 74 - "Community 74"
Cohesion: 0.15
Nodes (13): Abort, Admin APIs, `can_advance`, CI webhooks, Device failure reasons, Env, Hash algorithm (FW-4), MQTT `ota_update` (FW-4) (+5 more)

### Community 75 - "Community 75"
Cohesion: 0.10
Nodes (14): OtaConfig, OtaDownloadMode, OtaAdminRoutesDeps, createOtaRoutes(), OtaRoutesDeps, IFirmwareStorage, checkOtaRateLimit(), OtaCommandPublisher (+6 more)

### Community 76 - "Community 76"
Cohesion: 0.30
Nodes (14): getLocalIntegrationsCache(), applySocialDisconnected(), cacheKey(), cacheUserIntegrations(), enrichTokensFromRuntime(), getUserIntegrations(), getUserIntegrationsCacheTtlSec(), GmbIntegrationCache (+6 more)

### Community 77 - "Community 77"
Cohesion: 0.13
Nodes (17): ConnectRefreshCoordinator, ConnectRefreshCoordinatorDeps, getLocalConnectDebounce(), getLocalPublishHashCache(), resetLocalCachesForTests(), clearAllPublishHashesForDevice(), clearPublishHash(), hashPayload() (+9 more)

### Community 78 - "Community 78"
Cohesion: 0.12
Nodes (22): checkSchedulerHeartbeat(), processRollouts(), dashboardLink(), formatText(), sendOtaSlackAlert(), SlackOtaAlertKind, SlackOtaAlertPayload, canAdvanceStage() (+14 more)

### Community 79 - "Community 79"
Cohesion: 0.40
Nodes (4): Behaviour, Cloud / local config, Removal Checklist (after testing), stimulate/ — TEMP Testing-Phase (in-process)

### Community 80 - "Community 80"
Cohesion: 0.29
Nodes (7): 📡 API Endpoints, Create Session, Create User, Get All Devices, Health Check, Publish MQTT Message, Register Device

### Community 81 - "Community 81"
Cohesion: 0.18
Nodes (18): main(), MessageHandler, MqttConfig, MqttMessage, PendingAck, PublishMetadata, applyMqttJsTlsOptions(), buildMqttTlsPrecheckOptions() (+10 more)

### Community 82 - "Community 82"
Cohesion: 0.25
Nodes (4): HTTPServer, Handler, ReuseHTTPServer, SimpleHTTPRequestHandler

### Community 84 - "Community 84"
Cohesion: 0.11
Nodes (16): AuditEntry, AuditEventType, AuditLogData, AuditServiceConfig, getAuditService(), OtaReleaseLogEntry, mockAppendFileSync, mockGetInfluxService (+8 more)

### Community 85 - "Community 85"
Cohesion: 0.08
Nodes (20): main(), mongodbSrvHostname(), sanitizeUri(), validateUriShape(), mongoDriverTimeouts(), IUser, NOTE: This is a READ-ONLY model for mqtt-publisher-lite., User (+12 more)

### Community 86 - "Community 86"
Cohesion: 0.47
Nodes (5): DeviceCertSlot, DeviceCertStatus, isUniqueDeviceIdIndex(), main(), requireEnv()

### Community 87 - "Community 87"
Cohesion: 0.17
Nodes (11): ACLCacheEntry, ACLRule, ACLStats, ACLValidationResult, CertificateInfo, DeviceACL, DeviceConnectionInfo, DeviceTier (+3 more)

### Community 88 - "Community 88"
Cohesion: 0.20
Nodes (9): jest, tests/**/*.ts, compilerOptions, noEmit, types, extends, include, node (+1 more)

### Community 89 - "Community 89"
Cohesion: 0.20
Nodes (10): DEV-1: Unauthenticated dev OTA download (accepted temporary), Findings, H-1: mTLS identity from proxy header without fingerprint binding, H-2: OTA admin — any valid user JWT (interim), L-1: Static firmware testing UI, L-2: `/health` device enumeration (aggregate only), M-1: WebSocket `/ws` mirrors all MQTT traffic, M-2: Operational information disclosure (+2 more)

### Community 90 - "Community 90"
Cohesion: 0.13
Nodes (13): DeviceCertificateSchema, DeviceCertificateStatus, createProvisioningRoutes(), getTokenErrorCode(), ProvisioningDependencies, IMPORTANT: bind the token to the certificate being downloaded., CAConfig, DeviceAlreadyHasCertificateError (+5 more)

### Community 91 - "Community 91"
Cohesion: 0.13
Nodes (29): getGmbAccountLookupValues(), DeviceGmbContext, resolveGmbContextForDevice(), createAccessTokenOAuthClient(), getGmbApiAuth(), GmbApiAuth, gmbApiErrorMeta(), locationCacheKeyFromResourceName() (+21 more)

### Community 92 - "Community 92"
Cohesion: 0.42
Nodes (6): OtaEventsRepo, influxNsFromDate(), isValidInfluxNs(), normalizeInfluxTimestamp(), parseLineProtocolTimestampNs(), sanitizeInfluxLineProtocol()

### Community 93 - "Community 93"
Cohesion: 0.18
Nodes (10): build, builder, dockerfilePath, deploy, healthcheckPath, healthcheckTimeout, restartPolicyMaxRetries, restartPolicyType (+2 more)

### Community 94 - "Community 94"
Cohesion: 0.40
Nodes (5): 1. Install Dependencies, 2. Configure, 3. Run, 4. Test, 📋 Quick Start

### Community 95 - "Community 95"
Cohesion: 0.40
Nodes (5): Can't connect to MQTT broker, Data not persisting, MQTT messages not received, Port 3002 already in use, 🐛 Troubleshooting

### Community 96 - "Community 96"
Cohesion: 0.22
Nodes (9): Conservative Estimate for Pilot v1, Current Code-Derived Limits, Fleet Capacity Documentation, Gaps to Address Post-Pilot, Operational Recommendations, Performance Notes, Reconnect storm (manual / scheduled), Redis Storage Limits (+1 more)

### Community 97 - "Community 97"
Cohesion: 0.40
Nodes (5): Manual Testing, Run Tests, Test MQTT Connection, Test WebSocket, 🧪 Testing

### Community 99 - "Community 99"
Cohesion: 0.25
Nodes (6): fetchInstagramProfileMetrics(), InstagramProfileFetchAudit, InstagramProfileFetchError, InstagramProfileFetchResult, InstagramProfileMetrics, sha256Hex()

### Community 100 - "Community 100"
Cohesion: 0.83
Nodes (3): cleanup_stale_jest(), on_interrupt(), run-unit-tests.sh script

### Community 101 - "Community 101"
Cohesion: 0.14
Nodes (17): WebhookConfig, GmbReviewNotification, GmbReviewPayload, mapReviewPayloadToStorage(), ResolveGmbReviewPayloadOptions, GoogleBusinessReview, GmbConnectPull, sha256Payload() (+9 more)

### Community 102 - "Community 102"
Cohesion: 0.50
Nodes (4): Build, Docker Compose, 🐳 Docker Usage, Run

### Community 103 - "Community 103"
Cohesion: 0.50
Nodes (4): devices.json, sessions.json, 📂 Storage, users.json

### Community 104 - "Community 104"
Cohesion: 1.00
Nodes (3): baseUrl(), getJson(), main()

### Community 106 - "Community 106"
Cohesion: 0.12
Nodes (16): 1.1 `setActive` / `removeActive` — UNTESTED, 1.2 `updateLastSeen` — UNTESTED, 1.3 `getActive` / `getAllActive` / `count` — UNTESTED, 1.4 `flushAll` — UNTESTED, 1.5 Singleton + constructor — UNTESTED, 1. Coverage gaps — `ActiveDeviceCache`, 2.1 `registerDevice` — UNTESTED (highest-value CRUD), 2.2 `getDevice` — UNTESTED (+8 more)

### Community 108 - "Community 108"
Cohesion: 0.11
Nodes (17): 1.1 `LocalDeviceBackoff` — PARTIAL, 1.2 `LocalBudgetTracker` — PARTIAL, 1.3 `LocalCircuitGate` — UNTESTED, 1.4 `LocalFetchDedupe` — PARTIAL, 1.5 `LocalFairOffset` — UNTESTED, 1.6 `consumeFetchBudget` — PARTIAL, 1. Coverage gaps — rate-limit primitives, 2.1 Rollout selection — PARTIAL (+9 more)

### Community 109 - "Community 109"
Cohesion: 0.15
Nodes (11): Capacity, Deferred queue backlog / stale drops, Log contract (alert-ready), Policy (Phase 0), Rollback, Runbooks — ProofMQTT operations, Actions, Impact (pilot) (+3 more)

### Community 110 - "Community 110"
Cohesion: 0.67
Nodes (3): Add New Functionality, 📝 Development, Project Structure

### Community 111 - "Community 111"
Cohesion: 0.12
Nodes (15): 1.10 `getRootCACertificate` / `isInitialized` / `normalizeSlot` — UNTESTED, 1.11 Error classes — PARTIAL, 1.1 `initialize` — PARTIAL, 1.2 `generateRootCA` (private, via initialize) — PARTIAL, 1.3 `formatExpectedCN` — UNTESTED (critical prefix logic), 1.4 `signCSR` — PARTIAL (in-memory path only), 1.5 `findActiveCertificateByDeviceId` — UNTESTED (auth-critical), 1.6 `findCertificateById` / `findCertificateByDeviceId` — UNTESTED (+7 more)

### Community 112 - "Community 112"
Cohesion: 0.14
Nodes (13): 1.1 `buildObjectKey` / `buildS3Key` — UNTESTED (pure, cheap), 1.2 `createPresignedPutUrl` — UNTESTED, 1.3 `createPresignedGetUrl` — UNTESTED, 1.4 `buildParUrl` (private) — UNTESTED, 1.5 `headObject` — UNTESTED, 1.6 `verifySha256` — UNTESTED, 1.7 `getObjectStream` — UNTESTED, 1.8 `verifyBucketAccess` — UNTESTED (+5 more)

### Community 113 - "Community 113"
Cohesion: 0.33
Nodes (6): HTTP server, MQTT push, OTA download / verify, Serial port / flash, Troubleshooting, WiFi

### Community 114 - "Community 114"
Cohesion: 0.06
Nodes (23): ALLOWED_FLUX_FUNCTIONS, extractFunctionCalls(), KNOWN_MEASUREMENTS, sanitizeFluxQuery(), SanitizeResult, createDashboardRoutes(), DashboardRoutesDeps, requireAuth() (+15 more)

### Community 116 - "Community 116"
Cohesion: 0.15
Nodes (12): 1.1 `mapGmbStarRating` — UNTESTED (pure), 1.2 `getReview` — UNTESTED, 1.3 `listReviews` — UNTESTED, 1. Coverage gaps — `googleBusinessApi.ts`, 2.1 `isInvalidGrant` — UNTESTED (pure), 2.2 `createGoogleBusinessOAuth2Client` — UNTESTED, 2.3 `refreshAccessTokenIfNeeded` (private, via `getValidOAuth2Client`) — UNTESTED (token lifecycle core), 2.4 `getValidOAuth2Client` — UNTESTED (+4 more)

### Community 119 - "Community 119"
Cohesion: 0.15
Nodes (12): 1.1 `connect()` — UNTESTED (mock `redis.createClient`), 1.2 `disconnect()` — UNTESTED, 1.3 `getClient()` / `isRedisConnected()` — UNTESTED, 1.4 `healthCheck()` — UNTESTED, 1.5 `getCommandStats()` / `getStatsSince()` — UNTESTED, 1.6 `setupEventHandlers()` — UNTESTED, 1.7 `getStats()` — UNTESTED, 1.8 `safeTargetForLogs` / singleton — UNTESTED (+4 more)

### Community 122 - "Community 122"
Cohesion: 0.18
Nodes (9): buildGmbScreenPayload(), buildScreenEnvelope(), gmbReviewMetrics(), DeviceScreenState, gmbDemoVariant(), SAMPLE_GMB_REVIEWS, StatsPublisher, TEST_GMB_V6_VARIANTS (+1 more)

### Community 123 - "Community 123"
Cohesion: 0.20
Nodes (15): getActiveDeviceCache(), createRedisService(), getRedisService(), RedisConfig, ActiveSetRedisClient, devicesNeedingHydration(), HydrateActiveDeviceFn, republishCachedScreensForActiveDevices() (+7 more)

### Community 125 - "Community 125"
Cohesion: 0.33
Nodes (5): MQTT_BROKER, MQTT_PORT, MQTT_TLS_REJECT_UNAUTHORIZED, OTA_FIRMWARE_VERSION, run-e2e.sh script

### Community 126 - "Community 126"
Cohesion: 0.17
Nodes (11): 1.1 `initialize` — UNTESTED, 1.2 `logEvent` — UNTESTED (core chaining logic), 1.3 `verifyChain` — UNTESTED, 1.4 `getChainState` — UNTESTED, 1.5 Singleton (`createAuditService` / `getAuditService`) — UNTESTED, 1.6 Fallback file behavior — UNTESTED, 1. Coverage gaps — `AuditService` *(historical — now covered)*, 2. Testability notes / hazards for the suite (+3 more)

### Community 127 - "Community 127"
Cohesion: 0.29
Nodes (3): InfluxDBConfig, DeviceStateLogRepo, mockConfig

### Community 128 - "Community 128"
Cohesion: 0.50
Nodes (4): Device firmware config (mqttclient), Hardware & host, Prerequisites, Repos & tools

### Community 129 - "Community 129"
Cohesion: 0.50
Nodes (4): Production commands, Production OCI flow (server + Oracle Object Storage), Production verification checklist, Server prerequisites

### Community 130 - "Community 130"
Cohesion: 0.17
Nodes (11): 1.1 Input validation — UNTESTED, 1.2 JWT verification success paths — UNTESTED, 1.3 JWT verification failure paths — UNTESTED, 1.4 Post-verify payload validation — UNTESTED, 1.5 Outer catch-all — UNTESTED, 1.6 Constructor — UNTESTED, 1. Coverage gaps — `AuthService.verifyAuthToken` *(historical — now covered)*, 2. Testability notes (+3 more)

### Community 131 - "Community 131"
Cohesion: 0.33
Nodes (5): ✅ Already Implemented, Key Files to Examine, Next Steps, ❌ Not Implemented, Summary

### Community 132 - "Community 132"
Cohesion: 0.33
Nodes (5): Bun Runtime Security Notes, Known Risks, Mitigations, Monitoring, Version Policy

### Community 133 - "chainValidator.ts"
Cohesion: 0.40
Nodes (4): sha256, signature, size_bytes, version

### Community 134 - "Community 134"
Cohesion: 0.12
Nodes (15): Actions, Causes, Cert lookup 503, Related, Symptoms, Based on current codebase post-Phase 2 - NOT a pentest snapshot, - High (ops): M-16 Atlas allowlist, M-17 MQTT firewall still pending, Last Updated: 2026-07-02 (Phase 2 completion) (+7 more)

### Community 135 - "Community 135"
Cohesion: 0.17
Nodes (10): Apply with `gh` (from a machine that has local secrets), Branch protection (`main` on proof-firmware), Decisions, Firmware CI — Week 1 `staging` environment, Related, Rotate `OTA_RELEASE_WEBHOOK_SECRET`, Secrets (source map — never commit values), Variables (+2 more)

### Community 136 - "Community 136"
Cohesion: 0.22
Nodes (8): exclude, extends, include, dist, node_modules, src/**/*, tests/**/*, ./tsconfig.json

### Community 137 - "Community 137"
Cohesion: 0.60
Nodes (3): verify-broker-tls.sh script, usage(), verify_one()

### Community 139 - "Community 139"
Cohesion: 0.67
Nodes (3): Certificate revocation (NanoMQ), Pilot v1 hardening, 🔐 Security & limitations (V5.0)

### Community 143 - "Community 143"
Cohesion: 0.40
Nodes (4): express-serve-static-core, http, IncomingMessage, Request

### Community 144 - "Community 144"
Cohesion: 0.50
Nodes (3): Layout, Notes, PKI scripts

### Community 145 - "campaignSchedule.ts"
Cohesion: 0.17
Nodes (11): 1.1 Happy paths — UNTESTED, 1.2 Validity-date checks — UNTESTED, 1.3 Basic constraints — UNTESTED, 1.4 Signature verification — UNTESTED, 1.5 Parse/exception handling — UNTESTED, 1.6 `isChainValid` — UNTESTED, 1. Coverage gaps — `validateCertificateChain`, 2. Testability notes (+3 more)

### Community 146 - "Community 146"
Cohesion: 0.29
Nodes (4): createE2eApp(), sampleCertificateDoc(), buildPkiApp(), mockDeviceFindOne

### Community 148 - "Community 148"
Cohesion: 0.18
Nodes (10): 1.1 Early exits / gating — UNTESTED, 1.2 Debounce behavior — UNTESTED (core gating), 1.3 MQTT readiness — UNTESTED, 1.4 Integration fan-out — UNTESTED, 1.5 Promotion publish — UNTESTED, 1.6 `isDebounced` (private, via refresh) — PARTIAL, 1. Coverage gaps — `ConnectRefreshCoordinator.refresh`, 2. Testability notes (+2 more)

### Community 149 - "husky.sh"
Cohesion: 0.07
Nodes (27): 1. Generate CSR Locally, 2. Verify CSR Format, 3. Extract Public Key, 4. Test with Server, Common Name, 📊 Comparison: Your Spec vs Server Support, CSR Format, CSR Requirements Validation (+19 more)

### Community 150 - "post-applypatch"
Cohesion: 0.40
Nodes (5): Actions required for a **real** OTA release, High-level production path, Original production OTA flow (unchanged), Production download modes, Production env (secrets only — bucket is hardcoded)

### Community 152 - "post-commit"
Cohesion: 0.18
Nodes (10): 1.1 `enqueueConnectRefresh` — PARTIAL, 1.2 `enqueueOtaRegistration` — PARTIAL, 1.3 `processAll` — PARTIAL, 1.4 `resolveOtaRegistrationDeferConcurrency` — UNTESTED, 1.5 `isDeferredWorkRearmEnabled` — UNTESTED, 1. Coverage gaps, 2. Testability notes, 3. Defect / dead code observed (worth flagging) (+2 more)

### Community 153 - "sign-firmware.ts"
Cohesion: 0.18
Nodes (10): 1.1 Gate short-circuits — PARTIAL, 1.2 Audit events — UNTESTED (mock returns `null` today), 1.3 `formatExpectedCN` fallback — UNTESTED, 1.4 KU/EKU enforcement (`enforceRuntimeKuEku: true`) — UNTESTED, 1.5 Chain validation (`chainValidationEnabled: true`) — UNTESTED, 1. Coverage gaps — `ensureDeviceProvisioned`, 2. Testability notes, 3. Defect / dead code observed (worth flagging) (+2 more)

### Community 157 - "influxConfig.test.ts"
Cohesion: 0.06
Nodes (42): BootstrapHost, cacheActiveDevice(), extractDeviceIdFromTopic(), handleDeviceLWT(), handleDeviceOtaTelemetry(), handleDeviceRegistration(), handleDeviceStatus(), sendRegistrationResponse() (+34 more)

### Community 158 - "applypatch-msg"
Cohesion: 0.14
Nodes (13): 1.1 `enqueue` — PARTIAL, 1.2 `start` / `stopTimer` — UNTESTED, 1.3 `tick` / `flushNow` — UNTESTED, 1.4 `pickDrainTarget` — UNTESTED (crash-resume semantics), 1.5 `readAllLines` — UNTESTED, 1.6 `drainFile` — UNTESTED (the recovery contract), 1.7 `sendChunk` — PARTIAL, 1.8 `shutdown` — UNTESTED (+5 more)

### Community 159 - "commit-msg"
Cohesion: 0.39
Nodes (3): InstagramFetchAuditInfluxInput, ProfileBaselineInfluxInput, InstagramAuditRepo

### Community 163 - "Community 163"
Cohesion: 0.50
Nodes (4): 1. Boot — `/active` (QoS 1, retain false), 2. OTA failure — `/status` (QoS 1, retain false), Pilot MQTT contract (minimal — firmware v1), Server → device (unchanged)

### Community 166 - "post-merge"
Cohesion: 0.11
Nodes (16): CI validate-env, Configuration matrix, Feature env gates (in-process), Baseline re-verify, Error-code inventory (auth / webhooks), Execution order, GMB dedupe fail-open, Locked decisions (Phase 0 addendum) (+8 more)

### Community 178 - "swagger-jsdoc"
Cohesion: 0.17
Nodes (11): 1.1 `buildCampaignPayload` — PARTIAL (4 tests), 1.2 `filterSchedulableCampaigns` / `asCampaignForSchedule` — PARTIAL (4 tests), 1.3 `getNextPromotionIndex` — PARTIAL (1 test), 1.4 `getEligibleCampaignsForUser` — UNTESTED (needs `Campaign.find` mock), 1.5 `getPromotionCacheTtlSec` — PARTIAL (1 test), 1.6 Invalidation/fanout helpers — UNTESTED, 1.7 `handleConnectionValidateEvent` — PARTIAL (1 event), 1. Coverage gaps (+3 more)

### Community 188 - "📋 Your Requirements"
Cohesion: 0.20
Nodes (9): 1.1 `getCanvasCacheTtlSec` — UNTESTED, 1.2 `getCachedBrandCanvasAd` — UNTESTED (cache logic core), 1.3 `invalidateCanvasCache` — UNTESTED, 1.4 `buildBrandCanvasPayload` — PARTIAL, 1.5 `getRunningBrandCanvasAd` — PARTIAL, 1. Coverage gaps *(historical — now covered)*, 2. Testability notes, 3. Recommended priority order (+1 more)

### Community 190 - "dashboardRoutes.ts"
Cohesion: 0.17
Nodes (11): 1.1 `issueToken` — PARTIAL (P0 core closed), 1.2 `validateTokenWithoutRevoke` — PARTIAL (P0 core closed), 1.3 `peekToken` / `peekTokenForDownload` — RESOLVED, 1.4 `revokeToken` — RESOLVED, 1.5 `finalizeTokenAfterSuccessfulSignCsr` — RESOLVED, 1.6 `hasActiveToken` / `getTokenTTL` — RESOLVED, 1.7 `TokenStore` (dependency) — PARTIAL (P1 basics), 1. Coverage gaps (+3 more)

### Community 191 - "transparencyLog.ts"
Cohesion: 0.13
Nodes (8): app, shutdown(), SessionData, CtLogRepo, OtaReleaseEntryInput, TODO: extract to OtaReleaseLogRepo, TransparencyEntryInput, logger

### Community 194 - "helmet"
Cohesion: 0.31
Nodes (8): createLifecycleRoutes(), httpStatusForRecoveryError(), LifecycleDeps, postRecoveryWebhook(), reissueLimiter, decodeCsrToPem(), buildLifecycleRoutesApp(), mockFindOne

### Community 195 - "@influxdata/influxdb-client"
Cohesion: 0.18
Nodes (10): 1.1 `parseDeviceRecoveryToken` — PARTIAL (3 tests), 1.2 `registerSession` — PARTIAL (3 tests), 1.3 `getActiveSessionTtl` — UNTESTED, 1.4 `verifySession` — UNTESTED (core single-use gate), 1.5 `consumeSession` — UNTESTED, 1.6 `isAvailable` / `createRecoverySessionService` — UNTESTED, 1. Coverage gaps, 2. Defects / risks found (+2 more)

### Community 196 - "jsonwebtoken"
Cohesion: 0.22
Nodes (8): 1.1 Status / date window — PARTIAL, 1.2 `isTimeWindowActive` — UNTESTED (highest-value gap), 1.3 `isDayOfWeekActive` — PARTIAL, 1.4 `resolveTimezone` — UNTESTED (private, exercised via the above), 1. Coverage gaps — `isCampaignActive` *(historical — now covered)*, 2. Testability notes, 3. Recommended priority order, campaignSchedule — Test Suite Gap Report

### Community 198 - "node-forge"
Cohesion: 0.22
Nodes (8): 1.1 Stim gate — UNTESTED, 1.2 Context resolution — UNTESTED, 1.3 Rating normalization — UNTESTED, 1.4 Publish — UNTESTED, 1. Coverage gaps — `GmbConnectPull.publishForDevice`, 2. Testability notes, 3. Recommended priority order, gmbConnectPull — Test Suite Gap Report

### Community 200 - "prom-client"
Cohesion: 0.22
Nodes (8): 1.1 Merkle tree math — UNTESTED (pure, high value), 1.2 `addEntry` — UNTESTED, 1.3 `initialize` — UNTESTED, 1.4 Singleton factory — UNTESTED, 1. Coverage gaps, 2. Defects / risks found, 3. Suggested new test files, otaReleaseLog — Test Suite Gap Report

### Community 202 - "husky"
Cohesion: 0.25
Nodes (7): 1.1 `initialize` — UNTESTED, 1.2 `recordTransition` — UNTESTED (core chaining logic), 1.3 Singleton (`getDeviceStateLogService` / `createDeviceStateLogService`) — UNTESTED, 1. Coverage gaps — `DeviceStateLogService`, 2. Testability notes, 3. Recommended priority order, deviceStateLogService — Test Suite Gap Report

### Community 204 - "@types/node"
Cohesion: 0.14
Nodes (13): 1.1 URI building with `dbName` (L43–56, 72–74) — UNTESTED (pure logic, highest value), 1.2 `connect()` — UNTESTED (mock `mongoose`), 1.3 `sanitizeUri` (L114–129) — UNTESTED (pure logic), 1.4 `disconnect()` — UNTESTED, 1.5 `isMongoConnected()` / `getConnection()` / `getDatabase()` — UNTESTED, 1.6 `healthCheck()` — UNTESTED, 1.7 `setupEventHandlers()` (L195–222) — UNTESTED, 1.8 `createCollection` / `dropCollection` — UNTESTED (+5 more)

### Community 206 - "index.ts"
Cohesion: 0.33
Nodes (5): DeviceInfo, MqttMessage, PublishOptions, SessionInfo, UserInfo

### Community 207 - "E2E HTTP flow tests"
Cohesion: 0.33
Nodes (5): E2E HTTP flow tests, Environment, Flows covered, Manual MQTT / device E2E, Run

### Community 208 - "Redis down"
Cohesion: 0.25
Nodes (7): 1.1 `privateKeyFromEnv` / `normalizePemFromEnv` — UNTESTED, 1.2 `hasOciEnvCredentials` — UNTESTED, 1.3 `createOciAuthProvider` — UNTESTED (mock `oci-sdk`), 1. Coverage gaps, 2. Defects / risks found, 3. Suggested new test files, ociAuthProvider — Test Suite Gap Report

### Community 209 - "1. Architecture"
Cohesion: 0.31
Nodes (10): assertTestOtaAllowed(), deprecatedWarned, envBool(), envInt(), envString(), isTestOtaEnabled(), resolveMqttClientId(), warnDeprecatedEnv() (+2 more)

### Community 212 - "PkiAuditRepo"
Cohesion: 0.15
Nodes (12): 1.1 `start` / `stop` — UNTESTED, 1.2 `publishAllScreens` — UNTESTED (core cycle), 1.3 `ensureDeviceState` / `cleanupInactiveDeviceState` — UNTESTED, 1.4 `publishInstagram` (mock) — UNTESTED, 1.5 `publishTestGmb` — UNTESTED, 1.6 `publishPromotionForDevice` — UNTESTED (production path), 1.7 `publishDefaultCanvas` / `publishPromotionEnvelope` — UNTESTED, 1.8 `publishGmb` (mock) — UNTESTED (+4 more)

### Community 214 - "DeviceACL.ts"
Cohesion: 0.11
Nodes (20): ACLRule, ACLRuleSchema, DeviceACL, DeviceACLSchema, DeviceTier, IDeviceACL, IGoogleBusinessLocation, IGoogleBusinessProfile (+12 more)

### Community 215 - "LocalTtlCache"
Cohesion: 0.25
Nodes (7): 1.1 `mapOciError` — PARTIAL, 1.2 `isRetryableOciError` — PARTIAL, 1.3 `withOciRetry` — UNTESTED, 1. Coverage gaps, 2. Defects / risks found, 3. Suggested new test files, ociStorageErrors — Test Suite Gap Report

### Community 216 - "mongoDriverTimeouts"
Cohesion: 0.16
Nodes (12): CertLookupUnavailableError, ensureDeviceProvisioned(), hasValidKeyUsage(), KuEkuValidationResult, validateKeyUsageAndEKU(), baseProvisioning, certWithChain(), certWithPem() (+4 more)

### Community 218 - "1. Coverage gaps — `helpers.ts` (PARTIAL: 2 tests)"
Cohesion: 0.15
Nodes (12): 1.1 `priceToCents` — PARTIAL, 1.2 `getDateBucket` — PARTIAL, 1.3 `getStartOfDayInTimezone` — UNTESTED, 1.4 `getDateKeyForInstant` — UNTESTED, 1.5 Key builders — UNTESTED, 1.6 `escapeFluxString` — UNTESTED, 1. Coverage gaps — `helpers.ts` (PARTIAL: 2 tests), 2. Coverage gaps — `processDailyMetrics.ts` (UNTESTED entirely) (+4 more)

### Community 219 - "mqttConfig.ts"
Cohesion: 0.30
Nodes (11): decodeBase64ToUtf8(), firstPemEnv(), loadMqttConfig(), loadMqttTlsFromEnv(), looksLikeCertificatePem(), looksLikePem(), looksLikePrivateKeyPem(), normalizeMqttPemFromEnv() (+3 more)

### Community 220 - "provisioningConfig.ts"
Cohesion: 0.36
Nodes (10): decodeBase64ToUtf8(), DEFAULT_PROVISIONING_CA_STORAGE_PATH, describePrivateKeyPemKind(), getProvisioningRootCaCertFromEnv(), getProvisioningRootCaKeyFromEnv(), looksLikeCertificatePem(), looksLikePrivateKeyPem(), normalizeMqttPemFromEnv() (+2 more)

### Community 221 - "localCaches — Test Suite Gap Report"
Cohesion: 0.18
Nodes (10): 1. Coverage gaps — `LocalTtlCache<T>`, 2. Coverage gaps — `LocalStimLock`, 3. Coverage gaps — `LocalPublishHashCache`, 4. Coverage gaps — `LocalPromoRotationCache`, 5. Coverage gaps — `LocalConnectDebounce`, 6. Coverage gaps — `LocalProvCache` — UNTESTED (entirely), 7. Coverage gaps — singletons (`getLocalStimLock`, `getLocalPromoRotationCache`, `getLocalPublishHashCache`, `getLocalConnectDebounce`, `getLocalProvCache`, `getLocalPromoActiveCache`, `getLocalCanvasActiveCache`, `getLocalIntegrationsCache`) — UNTESTED, 8. Defects / risks found (+2 more)

### Community 222 - "1. Coverage gaps"
Cohesion: 0.18
Nodes (10): 1.1 `handleCritical` (/active, /lwt) — PARTIAL, 1.2 `handleNonCritical` guards — UNTESTED, 1.3 Provisioning gate — UNTESTED, 1.4 Topic dispatch + last-seen — UNTESTED, 1.5 `routeMqttMessage` top-level behavior — UNTESTED, 1.6 `flushMessageBuffer` — PARTIAL, 1. Coverage gaps, 2. Defects / risks found (+2 more)

### Community 223 - "SessionService"
Cohesion: 0.16
Nodes (14): nsToMs(), WebhookLatencyStages, WebhookLatencyTracker, WebhookProvider, computeVelocityPerDay(), ack(), handleGmbWebhook(), parseStarRating() (+6 more)

### Community 224 - "publishGmbScreen.ts"
Cohesion: 0.17
Nodes (11): 1.1 `buildScreenEnvelope` — UNTESTED, 1.2 `resolveCelebrationState` — PARTIAL, 1.3 `instagramFollowerMetrics` — PARTIAL, 1.4 `gmbReviewMetrics` — PARTIAL, 1.5 `buildInstagramScreenPayload` — PARTIAL, 1.6 `buildGmbScreenPayload` — PARTIAL, 1.7 `getInstagramMegaCrossedMilestones` — PARTIAL, 1. Coverage gaps (+3 more)

### Community 225 - "influxService — Test Suite Gap Report"
Cohesion: 0.20
Nodes (9): 1. Coverage gaps — constructor & wiring, 2. Coverage gaps — write delegates (routing partially proven), 2 (sic). Testability notes, 3. Coverage gaps — flush / close, 3. Recommended priority order, 4. Coverage gaps — queries (all 14 methods), 5. Coverage gaps — `healthCheck` (largest untested surface), 6. Coverage gaps — singleton (+1 more)

### Community 226 - "AppConfig"
Cohesion: 0.36
Nodes (7): AppConfig, MqttConfig, ProvisioningConfig, ConfigRoutesDeps, createConfigRoutes(), DeviceProvisioningGateDeps, buildConfigRoutesApp()

### Community 227 - "LocalDeviceBackoff"
Cohesion: 0.33
Nodes (6): ✅ **Common Name (CN) = device_id**, ✅ **CSR Format: PEM (PKCS#10)**, ✅ **Key Type: ECC (P-256 / secp256r1)**, ✅ **Public Key in CSR**, ✅ **Signature Algorithm: ECDSA + SHA-256**, 📋 Your Requirements

### Community 228 - "1. Coverage gaps"
Cohesion: 0.22
Nodes (8): 1.1 `publishIfChanged` — UNTESTED (core logic), 1.2 `publishForce` — UNTESTED, 1.3 `hashPayload` / `stableJson` — UNTESTED (internal), 1.4 Per-device/topic isolation — UNTESTED, 1. Coverage gaps, 2. Defects / risks found, 3. Suggested new test files, mqttChangeDetection — Test Suite Gap Report

### Community 229 - "🧪 Test It Works"
Cohesion: 0.29
Nodes (8): main(), parseArgs(), sha256Hex(), OtaOciConfig, createOciAuthProvider(), hasOciEnvCredentials(), normalizePemFromEnv(), privateKeyFromEnv()

### Community 231 - "otaDefaults.ts"
Cohesion: 0.14
Nodes (23): initializeHttpServer(), buildTestOtaDownloadUrl(), deliverOtaOnRegistration(), executeOtaRegistrationDelivery(), fanOutTestOtaToActiveDevices(), OtaRegistrationCoordinatorDeps, publishTestOtaToDevice(), initializeOtaServices() (+15 more)

### Community 232 - "otaSigningKeyService — Test Suite Gap Report"
Cohesion: 0.33
Nodes (5): 1.1 `initOtaSigningKeyAudit` — UNTESTED, 1. Coverage gaps, 2. Defects / risks found, 3. Suggested new test files, otaSigningKeyService — Test Suite Gap Report

### Community 233 - "🧪 Testing Your CSR"
Cohesion: 0.18
Nodes (10): 1.1 Env parsers (L37–58) — UNTESTED (pure), 1.2 Lock helpers (L60–80) — UNTESTED, 1.3 `start` — UNTESTED, 1.4 `stopOnDeviceDisconnect` / `resetOnDeviceConnect` — UNTESTED, 1.5 `spawnLoops` + tick — UNTESTED (fake timers), 1.6 `stopLoopsForDevice` / `stop` — UNTESTED, 1. Coverage gaps, 2. Defects / risks found (+2 more)

### Community 234 - "🔍 Server Implementation Details"
Cohesion: 0.40
Nodes (5): CSR Parsing, CSR Signature Verification, Device ID Validation, Public Key Extraction, 🔍 Server Implementation Details

### Community 235 - "Deferred queue backlog / stale drops"
Cohesion: 0.18
Nodes (10): 1.1 Merkle math (private, via addEntry) — UNTESTED, 1.2 `verifyInclusion` — UNTESTED (pure, highest value), 1.3 `addEntry` — UNTESTED, 1.4 `initialize` — UNTESTED, 1.5 `verifyConsistency` — UNTESTED, 1.6 `getCurrentRootHash` / `getEntryCount` / singleton — UNTESTED, 1. Coverage gaps, 2. Defects / risks found (+2 more)

### Community 236 - "OTA webhook reject"
Cohesion: 0.40
Nodes (4): Actions, Causes, OTA webhook reject, Symptoms

### Community 237 - "3. OTA subsystem — ambitious and footgun-prone"
Cohesion: 0.18
Nodes (10): 1.1 `cacheUserIntegrations` — UNTESTED (core builder), 1.2 `resolveGmbLocationId` — UNTESTED, 1.3 `enrichTokensFromRuntime` — UNTESTED (pure-ish), 1.4 `getUserIntegrations` / `invalidateUserIntegrations` — UNTESTED, 1.5 `applySocialDisconnected` — UNTESTED, 1.6 `getUserIntegrationsCacheTtlSec` — UNTESTED, 1. Coverage gaps, 2. Defects / risks found (+2 more)

### Community 238 - "CtLogRepo"
Cohesion: 0.31
Nodes (7): resolveConnectionsValidateApiKey(), ConnectionsRoutesDeps, createConnectionsRoutes(), PROVIDER_MAP, VALID_EVENTS, ConnectionValidateEvent, app()

### Community 242 - "1. Coverage gaps"
Cohesion: 0.20
Nodes (9): 1.1 `devicesNeedingHydration` — PARTIAL (3 tests), 1.2 `restoreActiveDevicesFromRedis` — UNTESTED, 1.3 `republishInstagramFromFollowersCache` — UNTESTED, 1.4 `republishGmbFromCache` — UNTESTED, 1.5 `republishCachedScreensForActiveDevices` — UNTESTED, 1. Coverage gaps, 2. Defects / risks found, 3. Suggested new test files (+1 more)

### Community 243 - "chainValidator.ts"
Cohesion: 0.31
Nodes (5): RFC-5280, ChainValidationResult, isChainValid(), validateCertificateChain(), KeyPair

### Community 244 - "gmb-pubsub.ts"
Cohesion: 0.44
Nodes (5): extractBearerToken(), getGmbPubsubAudience(), verifyPubSubPushRequest(), GmbPubsubVerifyConfig, PubSubPushVerificationResult

### Community 246 - "1. Coverage gaps"
Cohesion: 0.22
Nodes (8): 1.1 `buildBatchUpdates` — UNTESTED (pure, high value), 1.2 `sync` — PARTIAL (1 test), 1.3 `start` / `stop` / `flush` — UNTESTED, 1.4 Singleton — UNTESTED, 1. Coverage gaps, 2. Defects / risks found, 3. Suggested new test files, redisSync — Test Suite Gap Report

### Community 248 - "1. Coverage gaps"
Cohesion: 0.25
Nodes (7): 1.1 CRUD — UNTESTED, 1.2 TTL cleanup — UNTESTED (fake timers), 1.3 `close` — UNTESTED, 1. Coverage gaps, 2. Defects / risks found, 3. Suggested new test files, sessionService — Test Suite Gap Report

### Community 249 - "1. Coverage gaps"
Cohesion: 0.25
Nodes (7): 1.1 `initialize` / `isMongoConnected` / `disconnect` — UNTESTED, 1.2 `verifyUserExists` — UNTESTED, 1.3 `verifyDeviceUserAssociation` — UNTESTED, 1. Coverage gaps, 2. Defects / risks found, 3. Suggested new test files, userService — Test Suite Gap Report

### Community 251 - "webhookMetrics — Test Suite Gap Report"
Cohesion: 0.29
Nodes (6): 1.1 `WebhookLatencyTracker` — UNTESTED, 1.2 `nsToMs` (private) — covered implicitly via finish; assert bigint→ms conversion (e.g. 2.5 ms from 2 500 000 ns)., 1. Coverage gaps, 2. Defects / risks found, 3. Suggested new test files, webhookMetrics — Test Suite Gap Report

### Community 254 - "LocalTtlCache"
Cohesion: 0.12
Nodes (12): syncScreenFieldImmediate(), formatInstagramScreenMqttPayload(), publishInstagramScreenIfChanged(), getLocalStimLock(), LocalConnectDebounce, LocalProvCache, LocalTtlCache, ProvTokenEntry (+4 more)

### Community 256 - "IgMetricsRepo"
Cohesion: 0.10
Nodes (10): DeviceActiveInput, DeviceStateLogInput, GmbMetricsInput, GmbMilestoneInput, IgMetricsInput, IgMetricsRepo, IgMilestoneInput, MqttDeliveryInput (+2 more)

## Knowledge Gaps
- **1345 isolated node(s):** `root`, `parser`, `@typescript-eslint`, `eslint:recommended`, `plugin:@typescript-eslint/recommended` (+1340 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **56 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `logger` connect `transparencyLog.ts` to `IgMetricsRepo`, `Community 1`, `Community 0`, `Community 6`, `Community 8`, `Community 12`, `Community 20`, `influxConfig.test.ts`, `commit-msg`, `Community 37`, `Community 43`, `Community 47`, `Community 49`, `Community 52`, `Community 54`, `Community 55`, `Community 56`, `Community 58`, `Community 62`, `Community 65`, `helmet`, `Community 67`, `Community 69`, `Community 73`, `Community 75`, `Community 76`, `Community 77`, `Community 78`, `1. Architecture`, `Community 81`, `Community 84`, `Community 85`, `mongoDriverTimeouts`, `Community 90`, `Community 91`, `mqttConfig.ts`, `provisioningConfig.ts`, `SessionService`, `Community 101`, `otaDefaults.ts`, `CtLogRepo`, `Community 114`, `chainValidator.ts`, `Community 122`, `Community 123`, `LocalTtlCache`?**
  _High betweenness centrality (0.037) - this node is a cross-community bridge._
- **Why does `dependencies` connect `Community 14` to `node-forge`, `swagger-ui-express`, `uuid`, `Community 9`, `winston`, `Community 60`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._
- **Why does `InfluxService` connect `Community 3` to `IgMetricsRepo`, `transparencyLog.ts`, `SessionService`, `express-rate-limit`, `google-auth-library`, `GmbMilestoneRepo`, `mongoose`, `commit-msg`, `Community 8`, `Community 12`, `recoveryRoutes.ts`, `Community 49`, `httpProbe.ts`, `Community 54`, `Community 123`, `Community 92`, `influxConfig.test.ts`, `Community 127`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **What connects `root`, `parser`, `@typescript-eslint` to the rest of the system?**
  _1345 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05084745762711865 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.12535612535612536 - nodes in this community are weakly interconnected._
- **Should `Community 4` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._