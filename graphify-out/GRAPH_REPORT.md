# Graph Report - proofmqtt  (2026-09-16)

## Corpus Check
- 383 files · ~200,246 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 3118 nodes · 6543 edges · 217 communities (155 shown, 62 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 29 edges (avg confidence: 0.63)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `a9bce00a`
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
- Community 10
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
- Community 35
- Community 36
- Community 37
- Community 38
- Community 39
- Community 40
- Community 41
- Community 42
- Community 43
- Community 44
- Community 45
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
- Community 98
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
- 🚀 MQTT Publisher Lite
- tsconfig.eslint.json
- Community 124
- AppConfig
- gmb-pubsub.ts
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
- Community 142
- Community 143
- Community 144
- campaignSchedule.ts
- gmbSocial.ts
- Community 147
- Community 148
- husky.sh
- post-applypatch
- post-checkout
- post-commit
- sign-firmware.ts
- Manual Testing
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
- pre-rebase
- prepare-commit-msg
- swagger-jsdoc
- print-railway-broker-env.sh
- generate-keys.sh
- sign-firmware.sh
- upload-release.ts
- generate-broker-cert.sh
- promotionConfig.ts
- swaggerSchemas.ts
- express-rate-limit
- google-auth-library
- helmet
- Community 195
- jsonwebtoken
- mongoose
- post-commit
- post-merge
- post-rewrite
- pre-applypatch
- pre-auto-gc
- winston
- pre-commit
- pre-merge-commit
- pre-rebase
- prepare-commit-msg
- install.sh
- phase1_fix.sh
- flash-baseline.sh
- generate-keys.sh
- sign-firmware.sh
- generate-broker-cert.sh
- run-migration.sh
- sync-cursor-skill-commands.sh
- pre-push
- pre-push
- uuid
- {
  getIdString,
  buildReviewFromNotification,
  isGmbTestNotification,
  resolveGmbAccountResourceName,
  resolveGmbLocationResourceName,
  resolveGmbReviewPayload,
  resolveGmbReviewResourceName
}

## God Nodes (most connected - your core abstractions)
1. `logger` - 94 edges
2. `InfluxService` - 76 edges
3. `StatsMqttLite` - 63 edges
4. `Device` - 53 edges
5. `MqttClientManager` - 49 edges
6. `BootstrapHost` - 48 edges
7. `OtaService` - 45 edges
8. `RedisService` - 42 edges
9. `getIgDeviceRuntimeCache()` - 41 edges
10. `getRedisService()` - 41 edges

## Surprising Connections (you probably didn't know these)
- `readUsageCsv()` --indirect_call--> `dataDir()`  [INFERRED]
  tests/unit/services/influxServiceUsageCsv.test.ts → src/utils/leakHunter.ts
- `main()` --calls--> `mongoDriverTimeouts()`  [EXTRACTED]
  scripts/list-users.ts → src/config/mongoConnection.ts
- `main()` --calls--> `loadConfig()`  [EXTRACTED]
  scripts/ota/upload-firmware-oci.ts → src/config/index.ts
- `smokeLocalCaches()` --calls--> `getIgDeviceRuntimeCache()`  [EXTRACTED]
  scripts/smoke-redis-local.ts → src/services/igDeviceRuntimeCache.ts
- `smokeLocalCaches()` --calls--> `resetIgDeviceRuntimeCacheForTests()`  [EXTRACTED]
  scripts/smoke-redis-local.ts → src/services/igDeviceRuntimeCache.ts

## Import Cycles
- None detected.

## Communities (217 total, 62 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.07
Nodes (38): appClientDir, backupIfExists(), caConfig(), caStoragePath, cmdAppClient(), cmdInitCa(), cmdPrintAppEnv(), cmdRotate() (+30 more)

### Community 1 - "Community 1"
Cohesion: 0.11
Nodes (27): GmbReviewNotification, GmbReviewPayload, mapReviewPayloadToStorage(), ResolveGmbReviewPayloadOptions, nsToMs(), WebhookLatencyTracker, WebhookProvider, sha256Payload() (+19 more)

### Community 2 - "Community 2"
Cohesion: 0.08
Nodes (29): DeviceOtaStateSchema, DeviceOtaStatus, IDeviceOtaState, ObjectHeadResult, assertValidSha256Hex(), assertValidVersionFormat(), eventKey(), FinalizeValidationCode (+21 more)

### Community 3 - "Community 3"
Cohesion: 0.05
Nodes (42): 10. Daily Metrics — POS Order Tracking, 11. Connect Refresh Coordinator, 12. GMB Review Cache, 1. OtaRedisState — OTA Coordination, 2. Instagram Polling & Lua Scripts, 3. RecoverySessionService — Factory Reset Sessions, 4. PromotionService — Campaign Cache, 5. BrandCanvasService — Ad Cache (+34 more)

### Community 5 - "Community 5"
Cohesion: 0.05
Nodes (39): 1.10 Webhook Deduplication (redisDedupe.ts), 1.11 GMB Review Cache (gmbReviewCache.ts), 1.12 CSR Rate Limiter (csrRateLimiter.ts / csrRateLimitLua.ts), 1.13 Recovery Sessions (recoverySessionService.ts), 1.14 OTA State (otaService.ts — OtaRedisState), 1.15 OTA Rollout Scheduler (rolloutScheduler.ts), 1.16 Stimulate Service (stimulateService.ts), 1.17 Connect Refresh Coordinator (connectRefreshCoordinator.ts) (+31 more)

### Community 6 - "Community 6"
Cohesion: 0.05
Nodes (38): 0. CONTEXT & PROJECT UNDERSTANDING, 1.1 H-1: mTLS Fingerprint Binding at HTTP Edge, 1.2 H-2: Admin JWT Scope Hardening (Interim → Permanent), 1.3 DEV-1: Keep Dev OTA Route — Rename for Pilot v1, 1.4 M-1: Remove WebSocket Server Completely, 1.5 M-2: Trim Health Endpoint Information Disclosure, 1.6 M-3: CORS Origin Restriction, 1.7 M-4: CSR Rate Limiter — Fallback to Local Cache (+30 more)

### Community 7 - "Community 7"
Cohesion: 0.07
Nodes (31): atomicBackoffCheckAndRecordLua, atomicFetchBudgetTryLua, atomicPriorityReadAndPruneLua, AttentionE2eLatencySnapshot, buildLatencySnapshot(), correlationStartMs, counters, evalAtomicPriorityReadAndPruneEvalSha() (+23 more)

### Community 8 - "Community 8"
Cohesion: 0.06
Nodes (34): 1.1 Webhook Routes (`/api/webhooks/*`), 1.2 Promotion Routes (`/api/v1/promotions/*`), 1.3 Connections Routes (`/api/v1/connections/*`), 2.1 Device OTA Routes (`/api/v1/ota/*`), 2.2 Admin OTA Routes (`/api/v1/admin/ota/*`), 3.1 Provisioning Routes (`/api/v1/onboarding/*`), 3.2 Config Routes (`/api/v1/config/*`), 3.3 Lifecycle Routes (`/api/v1/lifecycle/*`) (+26 more)

### Community 9 - "Community 9"
Cohesion: 0.10
Nodes (34): getGmbAccountLookupValues(), DeviceGmbContext, createAccessTokenOAuthClient(), getGmbApiAuth(), GmbApiAuth, gmbApiErrorMeta(), locationCacheKeyFromResourceName(), pickAccessibleLocation() (+26 more)

### Community 10 - "Community 10"
Cohesion: 0.12
Nodes (17): 📚 Additional Resources, After (Redis Cloud):, Before (Local):, Best Practices, Check Logs, Connection Flow, 🔍 How It Works, 🔄 Migration from Local Redis (+9 more)

### Community 11 - "Community 11"
Cohesion: 0.14
Nodes (23): resolveGmbContextForDevice(), ConnectRefreshCoordinator, ConnectRefreshCoordinatorDeps, GmbConnectPull, getLocalIntegrationsCache(), DeviceScreenState, SAMPLE_GMB_REVIEWS, TEST_GMB_V6_VARIANTS (+15 more)

### Community 12 - "Community 12"
Cohesion: 0.06
Nodes (23): StatsMqttLite, setMqttTlsClientPem(), DeferredDeviceWorkQueue, DeferredDrainResult, DeferredWorkItem, isDeferredWorkRearmEnabled(), resolveDeferredWorkHandlerTimeoutMs(), resolveOtaRegistrationDeferConcurrency() (+15 more)

### Community 14 - "Community 14"
Cohesion: 0.05
Nodes (39): compression, cors, dotenv, express-rate-limit, google-auth-library, helmet, @influxdata/influxdb-client, jsonwebtoken (+31 more)

### Community 15 - "Community 15"
Cohesion: 0.10
Nodes (37): REDIS_KEYS, app, logMemoryUsage(), ensureFreshInstagramAccessToken(), InstagramTokenContext, loadInstagramTokenContextForUser(), updateDeviceTokenInRedis(), getActiveDeviceCache() (+29 more)

### Community 16 - "Community 16"
Cohesion: 0.21
Nodes (15): canAdvanceStage(), classifyOtaReason(), deviceHashBucket(), mapPool(), nextRolloutPercentage(), normalizeOtaReasonCode(), OTA_ROLLOUT_STEPS, OtaReasonKind (+7 more)

### Community 17 - "Community 17"
Cohesion: 0.27
Nodes (10): ALLOWED_FLUX_FUNCTIONS, extractFunctionCalls(), KNOWN_MEASUREMENTS, sanitizeFluxQuery(), SanitizeResult, createInfluxQueryRoutes(), InfluxQueryRoutesDeps, LEGACY_MEASUREMENTS (+2 more)

### Community 18 - "Community 18"
Cohesion: 0.07
Nodes (30): compilerOptions, allowSyntheticDefaultImports, baseUrl, declaration, declarationMap, esModuleInterop, forceConsistentCasingInFileNames, lib (+22 more)

### Community 19 - "Community 19"
Cohesion: 0.07
Nodes (5): correlationIdMiddleware(), HttpServer, MqttClientManager, resolveMqttFullTopic(), SessionService

### Community 20 - "Community 20"
Cohesion: 0.09
Nodes (27): WebhookConfig, WebhookDeviceTarget, captureRawBody, createWebhookRoutes(), extractBearerToken(), gmbLimiter, otaReleaseLimiter, OtaReleaseWebhookDeps (+19 more)

### Community 21 - "Community 21"
Cohesion: 0.16
Nodes (16): LoopState, parseGmbTarget(), parseIgTarget(), parseIntervalMs(), parsePlatforms(), parseStep(), refreshStimLock(), StartDeps (+8 more)

### Community 22 - "Community 22"
Cohesion: 0.14
Nodes (3): REDIS_READ_COMMANDS, REDIS_WRITE_COMMANDS, RedisService

### Community 23 - "Community 23"
Cohesion: 0.07
Nodes (28): Actual Retention Mechanism, Appendices, Appendix A: Retention Policy History, Appendix B: Cost Tracking, Application Configuration, Architecture, Boot-time retention verification (recommended), Compliance Considerations (+20 more)

### Community 24 - "Community 24"
Cohesion: 0.12
Nodes (27): buildObjectKey(), buildParUrl(), { common, objectstorage }, createOciClient(), createOciDownloadUrl(), hasOciEnvCredentials(), normalizePem(), OTA_PRESIGNED_TTL_SEC (+19 more)

### Community 25 - "Community 25"
Cohesion: 0.24
Nodes (9): ACLRule, ACLRuleSchema, DeviceACL, DeviceACLSchema, DeviceTier, IDeviceACL, IGoogleBusinessLocation, IGoogleBusinessProfile (+1 more)

### Community 26 - "Community 26"
Cohesion: 0.17
Nodes (6): LoyaltySession, ILoyaltySpin, LoyaltySpin, incLoyaltySpinFailure(), LoyaltyService, isDuplicateKeyError()

### Community 27 - "Community 27"
Cohesion: 0.16
Nodes (7): FairOffset, FetchDedupe, LocalDeviceBackoff, LocalFairOffset, LocalFetchDedupe, OtaStatusReader, resetLocalOtaFleetTrackerForTests()

### Community 28 - "Community 28"
Cohesion: 0.11
Nodes (15): InfluxDBConfig, BaseInfluxRepo, OtaReleaseEntryInput, TODO: extract to OtaReleaseLogRepo, TransparencyEntryInput, DeviceActiveInput, DeviceActiveRepo, DeviceStateLogInput (+7 more)

### Community 29 - "Community 29"
Cohesion: 0.13
Nodes (14): HttpConfig, ActiveDevice, ProvisioningConfig, ProvisioningTokenPayload, TokenValidationResult, SessionData, WebhookLatencyStages, LocalStoreFile (+6 more)

### Community 30 - "Community 30"
Cohesion: 0.20
Nodes (6): DeviceOtaState, FirmwareRelease, IFirmwareRelease, syncHashFieldsImmediate(), OtaService, isVersionGreater()

### Community 31 - "Community 31"
Cohesion: 0.11
Nodes (17): RFC-5280, CertLookupUnavailableError, ChainValidationResult, isChainValid(), validateCertificateChain(), ensureDeviceProvisioned(), hasValidKeyUsage(), KuEkuValidationResult (+9 more)

### Community 33 - "Community 33"
Cohesion: 0.07
Nodes (40): shutdown(), fetchInstagramProfileMetrics(), getIgFetchBodySizeSnapshot(), InstagramProfileFetchAudit, InstagramProfileFetchError, InstagramProfileFetchResult, InstagramProfileMetrics, sha256Hex() (+32 more)

### Community 34 - "Community 34"
Cohesion: 0.10
Nodes (22): LOYALTY_ACTIVE_SESSION_STATUSES, LoyaltySessionSchema, LoyaltySessionStatus, ILoyaltySpinResult, LOYALTY_IN_FLIGHT_SPIN_STATUSES, LoyaltySpinResultSchema, LoyaltySpinSchema, LoyaltySpinStatus (+14 more)

### Community 35 - "Community 35"
Cohesion: 0.14
Nodes (5): InfluxDiskQueue, InfluxDiskQueueOptions, influxWriteErrorMessage(), isPermanentInfluxWriteError(), rotateKeepingOne()

### Community 36 - "Community 36"
Cohesion: 0.09
Nodes (22): OtaConfig, OtaDownloadMode, FirmwareReleaseSchema, FirmwareReleaseStatus, FirmwareRolloutSchema, FirmwareRolloutStrategy, IFirmwareRollout, createOtaAdminRoutes() (+14 more)

### Community 38 - "Community 38"
Cohesion: 0.08
Nodes (23): dist/, node_modules/, extends, ignorePatterns, parser, parserOptions, project, plugins (+15 more)

### Community 39 - "Community 39"
Cohesion: 0.08
Nodes (22): BootstrapHost, cacheActiveDevice(), extractDeviceIdFromTopic(), handleDeviceLWT(), handleDeviceOtaTelemetry(), handleDeviceRegistration(), handleDeviceStatus(), sendRegistrationResponse() (+14 more)

### Community 40 - "Community 40"
Cohesion: 0.20
Nodes (14): initializeHttpServer(), buildTestOtaDownloadUrl(), deliverOtaOnRegistration(), executeOtaRegistrationDelivery(), fanOutTestOtaToActiveDevices(), OtaRegistrationCoordinatorDeps, publishTestOtaToDevice(), initializeOtaServices() (+6 more)

### Community 41 - "Community 41"
Cohesion: 0.14
Nodes (11): checkSchedulerHeartbeat(), processRollouts(), dashboardLink(), formatText(), sendOtaSlackAlert(), SlackOtaAlertKind, SlackOtaAlertPayload, compareVersions() (+3 more)

### Community 42 - "Community 42"
Cohesion: 0.12
Nodes (17): scripts, build, check, check:full, coverage, dev, format, lint (+9 more)

### Community 43 - "Community 43"
Cohesion: 0.09
Nodes (22): 1.1 Remove Committed Private Keys from Repo, 1.2 Update .env.example with Admin Auth, 1. Immediate (P1 Priority), 2.1 Migrate Runtime to Bun, 2.2 Remove Render Configuration, 2.3 Add ESLint + Prettier, 2. Medium Priority (2-3 days), 3.1 Core Infrastructure (+14 more)

### Community 45 - "Community 45"
Cohesion: 0.18
Nodes (9): check(), main(), Result, results, smokeProvAndSync(), resetIgDeviceRuntimeCacheForTests(), resetLocalCachesForTests(), createRedisService() (+1 more)

### Community 46 - "Community 46"
Cohesion: 0.31
Nodes (4): createE2eApp(), sampleCertificateDoc(), buildPkiApp(), mockDeviceFindOne

### Community 47 - "Community 47"
Cohesion: 0.06
Nodes (35): Close-out Checklist, Completed: P3.1 - Fleet Capacity Documentation, Completed: P3.2 - Prometheus Alerts, Completed: P3.3 - Global Rate Limiting, Completed: P3.4 - Compliance Documentation, Completed: P3.7 - Security Audit Checklist, Current (2026-07-02), Detailed Roadmap (+27 more)

### Community 49 - "Community 49"
Cohesion: 0.08
Nodes (23): 1. MQTT and presence (do not invent a second subsystem), 2. Call sequence (strict), 3.1 Public page `/linktree/{deviceId}`, 3.2 BFF `POST /api/loyalty/spin` (statsnapp server), 3.3 Reconciliation (Prisma vs Node `loyalty_spins`), 3.4 What the web app must **not** do, 3. Web app (statsnapp) responsibilities, 4. Payloads the web app must parse (+15 more)

### Community 50 - "Community 50"
Cohesion: 0.12
Nodes (16): 📊 Comparison: Your Spec vs Server Support, CSR Requirements Validation, 📝 Example: ESP32 CSR Generation, ✅ Final Verdict, 🚀 Next Steps, **One-Line Summary:**, 📚 References, 🔒 Security Considerations (+8 more)

### Community 51 - "Community 51"
Cohesion: 0.17
Nodes (16): checkLocalShortCircuit(), csrRateLimiter(), DEFAULT_CONFIG, incrementLocalCounter(), localCounters, RateLimitConfig, rejectRateLimited(), resetCsrLocalCounters() (+8 more)

### Community 52 - "Community 52"
Cohesion: 0.12
Nodes (24): getCrossedMilestones(), buildGmbScreenPayload(), buildInstagramScreenPayload(), buildLoyaltySpinStartEnvelope(), buildScreenEnvelope(), BuildScreenEnvelopeOpts, CelebrationState, CelebrationType (+16 more)

### Community 53 - "Community 53"
Cohesion: 0.23
Nodes (9): httpRequestDuration, httpRequestsTotal, metricsHandler(), metricsMiddleware(), metricsRegister, ActivityCounters, counters, incActivity() (+1 more)

### Community 54 - "Community 54"
Cohesion: 0.14
Nodes (14): Attention polling — implementation status, Code references, Dual schedulers — priority and background (both implemented), Intended flow (device scan / NFC), Phase B — Attention / priority signals, Phase C — Fairness, starvation, budgets, Phase D — Observability, Phase E — Topology & dedupe (+6 more)

### Community 55 - "Community 55"
Cohesion: 0.10
Nodes (19): App Wiring (`src/app.ts`), Audit Events (`src/services/auditService.ts`), Code Gaps, Config (`src/config/index.ts`), Docs, Fixes, InfluxDB Refinement Actions, InfluxService (`src/services/influxService.ts`) (+11 more)

### Community 56 - "Community 56"
Cohesion: 0.20
Nodes (11): assertTestOtaAllowed(), isTestOtaEnabled(), createOtaRoutes(), OtaRoutesDeps, checkOtaRateLimit(), OtaEventHandler, isFirmwareBin(), LocalTestOtaFirmware (+3 more)

### Community 57 - "Community 57"
Cohesion: 0.27
Nodes (6): getTransparencyLog(), TransparencyLogConfig, TransparencyProof, computeRootFromLeaves(), merkleHash(), mockGetInfluxService

### Community 58 - "Community 58"
Cohesion: 0.14
Nodes (5): DeviceBackoff, chunk(), InstagramDirectFetchInvoker, InstagramPoller, resolveDeviceMeta()

### Community 60 - "Community 60"
Cohesion: 0.33
Nodes (5): engines, bun, name, type, version

### Community 61 - "Community 61"
Cohesion: 0.05
Nodes (73): main(), productionMode, computeAudience(), main(), deprecatedWarned, envBool(), envInt(), envString() (+65 more)

### Community 62 - "Community 62"
Cohesion: 0.17
Nodes (18): formatInstagramScreenMqttPayload(), ScreenDeliveryFetchShape, getLocalStimLock(), resolveCelebrationState(), ensureStimGmbLock(), releaseStimGmbLock(), runGmbTick(), updateGmbCache() (+10 more)

### Community 64 - "Community 64"
Cohesion: 0.15
Nodes (13): 🎯 Behavior After Fix, 📋 Environment Variables, 🔍 Files Modified, 🐛 Problem, Redis Connection Fix - Deployment Issue Resolution, 🎉 Result, Root Causes, ✅ Testing (+5 more)

### Community 65 - "Community 65"
Cohesion: 0.09
Nodes (23): 10. Verdict table, 11. Bottom line, 3. OTA subsystem — ambitious and footgun-prone, 4. Database and storage choices, 5. Configuration — env variable hell, 6. Testing — thin for size, not absent, 7. Directory structure and file gravity, 8. Feature focus — scope creep (+15 more)

### Community 66 - "Community 66"
Cohesion: 0.22
Nodes (11): loyaltySecretRequired(), createLoyaltyRoutes(), demandService(), LoyaltyRoutesDeps, requireLoyaltySpinKey(), sendLoyaltyError(), validateLoyaltyResult(), LoyaltyHttpError (+3 more)

### Community 67 - "Community 67"
Cohesion: 0.10
Nodes (7): getLocalConnectDebounce(), getLocalPromoRotationCache(), LocalConnectDebounce, LocalPromoRotationCache, LocalProvCache, LocalTtlCache, ProvTokenEntry

### Community 68 - "Community 68"
Cohesion: 0.18
Nodes (11): DailyMetricsRedisKeys, DateBucketResult, getDailyMetricsKeys(), getDateBucket(), getStartOfDayInTimezone(), getTimezoneOffsetMs(), priceToCents(), resolveMetricsTimezone() (+3 more)

### Community 69 - "Community 69"
Cohesion: 0.42
Nodes (6): OtaEventsRepo, influxNsFromDate(), isValidInfluxNs(), normalizeInfluxTimestamp(), parseLineProtocolTimestampNs(), sanitizeInfluxLineProtocol()

### Community 70 - "Community 70"
Cohesion: 0.17
Nodes (12): ⚡ 30-Second Setup, Can't connect to MQTT broker?, 📂 Check Your Data, 🔧 Customize, Data not saving?, 📚 Next Steps, Port 3002 in use?, 🚀 Quick Start Guide - MQTT Publisher Lite (+4 more)

### Community 71 - "Community 71"
Cohesion: 0.05
Nodes (39): bun-types, eslint, husky, devDependencies, bun-types, eslint, husky, prettier (+31 more)

### Community 72 - "Community 72"
Cohesion: 0.10
Nodes (21): 1. Boot — `/active` (QoS 1, retain false), 2. OTA failure — `/status` (QoS 1, retain false), Admin API (Bearer user JWT), CI webhook — automated release + staged rollout, Device HTTP — `GET /api/v1/ota/download/:version` (proxy mode, optional), Device HTTP — `POST /api/v1/ota/report` (optional fallback), Enable OTA, Finalize validation (server) (+13 more)

### Community 73 - "Community 73"
Cohesion: 0.08
Nodes (25): Architecture (what you are testing), Device firmware config (mqttclient), ESP32 OTA End-to-End Manual Test Guide, Files in this repo, Hardware & host, MQTT topics (must match server `MQTT_TOPIC_ROOT`), OTA command payload (server → device), Prerequisites (+17 more)

### Community 74 - "Community 74"
Cohesion: 0.17
Nodes (11): abandonAttentionCorrelation(), applyInstagramServerlessDeviceOutcome(), getOutcomeCircuitGate(), igPollMetricsInc(), maybeApplyGlobalCircuit(), maybeOpenCircuitFromOutcome(), NormalizedDeviceFetchResult, readCachedFollowers() (+3 more)

### Community 75 - "Community 75"
Cohesion: 0.25
Nodes (4): ChainState, DeviceStateEvent, DeviceStateTransitionInput, mockGetInfluxService

### Community 77 - "Community 77"
Cohesion: 0.14
Nodes (7): OTA Download Endpoint, Pilot v1 Exceptions, Health, Production setup, Scope, Shadow mode, Webhook → MQTT (GMB MVP)

### Community 78 - "Community 78"
Cohesion: 0.25
Nodes (8): Baseline re-verify, Error-code inventory (auth / webhooks), Execution order, GMB dedupe fail-open, Locked decisions (Phase 0 addendum), Logic risks (inventory), Phase 0 — Production Hardening Assessment, Production readiness scores (post re-verify)

### Community 79 - "Community 79"
Cohesion: 0.13
Nodes (14): **1\. Executive Summary & Design Goals**, **2\. Comprehensive Concept Verification Matrix**, **3.1 Dual-Path Trigger Engine**, **3.2 State Tracking Mechanics**, **3\. Core Subsystem Operations**, **4.1 Cooldown and Blacklist Management**, **4.2 Post-Update Safety Architecture**, **4.3 Handshake Reliability (QoS 1 Application Loop)** (+6 more)

### Community 80 - "Community 80"
Cohesion: 0.13
Nodes (14): **1\. Executive Summary & Design Goals**, **2\. Comprehensive Concept Verification Matrix**, **3.1 Dual-Path Trigger Engine**, **3.2 State Tracking Mechanics**, **3\. Core Subsystem Operations**, **4.1 Cooldown and Blacklist Management**, **4.2 Post-Update Safety Architecture**, **4.3 Handshake Reliability (QoS 1 Application Loop)** (+6 more)

### Community 81 - "Community 81"
Cohesion: 0.17
Nodes (13): clearStimCache(), key(), readStimCache(), StimCacheEntry, store, writeStimCache(), resolveLiveFollowersForStim(), mockPublishGmbScreen (+5 more)

### Community 82 - "Community 82"
Cohesion: 0.25
Nodes (4): Handler, ReuseHTTPServer, HTTPServer, SimpleHTTPRequestHandler

### Community 83 - "Community 83"
Cohesion: 0.23
Nodes (14): initializeConnectRefreshCoordinator(), initializeInfluxDB(), initializeInstagramPoller(), initializeKeepAlive(), initializePhase2(), initializePkiGovernance(), initializeStatsPublisher(), initializeStimulateService() (+6 more)

### Community 84 - "Community 84"
Cohesion: 0.29
Nodes (11): Business, BusinessSchema, IBusiness, NOTE: This is a READ-ONLY model for mqtt-publisher-lite., LoyaltyMqttClient, buildLoyaltyIdleMqttMessage(), publishLoyaltyIdle(), publishLoyaltyIdleForDevice() (+3 more)

### Community 85 - "Community 85"
Cohesion: 0.22
Nodes (4): invalidateCache(), GmbMilestoneInput, IgMetricsInput, IgMilestoneInput

### Community 86 - "Community 86"
Cohesion: 0.47
Nodes (5): DeviceCertSlot, DeviceCertStatus, isUniqueDeviceIdIndex(), main(), requireEnv()

### Community 87 - "Community 87"
Cohesion: 0.15
Nodes (13): Abort, Admin APIs, `can_advance`, CI webhooks, Device failure reasons, Env, Hash algorithm (FW-4), MQTT `ota_update` (FW-4) (+5 more)

### Community 88 - "Community 88"
Cohesion: 0.27
Nodes (3): AuditService, DeviceStateLogService, getInfluxService()

### Community 89 - "Community 89"
Cohesion: 0.36
Nodes (3): BudgetTracker, consumeFetchBudget(), LocalBudgetTracker

### Community 90 - "Community 90"
Cohesion: 0.14
Nodes (11): ILoyaltySession, ackLatency, clockDriftWarn, deviceAckSkew, failures, incLoyaltyClockDriftWarn(), incLoyaltySessionExpiry(), observeLoyaltyAckLatencyMs() (+3 more)

### Community 91 - "Community 91"
Cohesion: 0.29
Nodes (9): RFC-1918, attachLoyaltyWs(), clientIpFromUpgrade(), onConnection(), RateEntry, isAllowedLoyaltyOrigin(), isDevLikeEnv(), isLoopbackHost() (+1 more)

### Community 92 - "Community 92"
Cohesion: 0.05
Nodes (41): Device, DeviceSchema, DeviceStatus, DeviceCertificateSchema, DeviceCertificateStatus, createLifecycleRoutes(), httpStatusForRecoveryError(), LifecycleDeps (+33 more)

### Community 93 - "Community 93"
Cohesion: 0.17
Nodes (12): Actions required for a **real** OTA release, Cleanup checklist (after device test passes), Direct OCI URL (optional sanity check), Download URL for firmware developer, High-level production path, Original production OTA flow (unchanged), OTA dev download test (temporary), Production download modes (+4 more)

### Community 94 - "Community 94"
Cohesion: 0.17
Nodes (12): Admin OTA (interim → planned), Attack surface (production), Change log, Controls verified (positive), Executive summary, POS / integrations webhooks (production today), Production OTA (target state — already implemented except dev route), proofmqtt Security Assessment (+4 more)

### Community 96 - "Community 96"
Cohesion: 0.29
Nodes (5): Actions, Boot failure, Common causes, Related, Symptoms

### Community 98 - "Community 98"
Cohesion: 0.17
Nodes (11): ACLCacheEntry, ACLRule, ACLStats, ACLValidationResult, CertificateInfo, DeviceACL, DeviceConnectionInfo, DeviceTier (+3 more)

### Community 99 - "Community 99"
Cohesion: 0.18
Nodes (10): Based on current codebase post-Phase 2 - NOT a pentest snapshot, - High (ops): M-16 Atlas allowlist, M-17 MQTT firewall still pending, Last Updated: 2026-07-02 (Phase 2 completion), - Low: Admin domain-list auth (IdP deferred), - Medium: GMB/OTA webhook dedupe fail-open when Redis down (pilot accepted; alert dedupe_fail_open), - Medium: In-memory deferred queue lost on restart / multi-instance (pilot limit), - Medium: No CRL/OCSP (soft revoke only), Previous Pentest Date: 2026-06-23 (+2 more)

### Community 100 - "Community 100"
Cohesion: 0.18
Nodes (10): build, builder, dockerfilePath, deploy, healthcheckPath, healthcheckTimeout, restartPolicyMaxRetries, restartPolicyType (+2 more)

### Community 101 - "Community 101"
Cohesion: 0.29
Nodes (5): mockCacheUserIntegrations, mockClearHashes, mockGetActive, mockGetUserIntegrations, mockShouldSkip

### Community 102 - "Community 102"
Cohesion: 0.33
Nodes (6): 1. Added `isRedisConfigured()` Method, 2. Added Configuration Check in `connect()` Method, 3. Added Configuration Check in `app.ts`, 4. Fixed `disconnect()` Error Handling, 5. Updated Config Validation, ✅ Solution

### Community 103 - "Community 103"
Cohesion: 0.10
Nodes (21): AuditEntry, AuditEventType, AuditLogData, AuditServiceConfig, getAuditService(), createOtaReleaseLog(), getOtaReleaseLog(), OtaReleaseLogEntry (+13 more)

### Community 104 - "Community 104"
Cohesion: 1.00
Nodes (3): baseUrl(), getJson(), main()

### Community 106 - "Community 106"
Cohesion: 0.33
Nodes (3): ENV_KEYS, mockConfig, mockHttpGet

### Community 109 - "Community 109"
Cohesion: 0.20
Nodes (10): Apply with `gh` (from a machine that has local secrets), Branch protection (`main` on proof-firmware), Decisions, Firmware CI — Week 1 `staging` environment, Related, Rotate `OTA_RELEASE_WEBHOOK_SECRET`, Secrets (source map — never commit values), Variables (+2 more)

### Community 110 - "Community 110"
Cohesion: 0.20
Nodes (10): DEV-1: Unauthenticated dev OTA download (accepted temporary), Findings, H-1: mTLS identity from proxy header without fingerprint binding, H-2: OTA admin — any valid user JWT (interim), L-1: Static firmware testing UI, L-2: `/health` device enumeration (aggregate only), M-1: WebSocket `/ws` mirrors all MQTT traffic, M-2: Operational information disclosure (+2 more)

### Community 111 - "Community 111"
Cohesion: 0.24
Nodes (5): main(), OCI_PYTHON_SDK_CONNECTION_TIMEOUT, OCI_PYTHON_SDK_READ_TIMEOUT, instance.sh script, write_metadata()

### Community 112 - "Community 112"
Cohesion: 0.20
Nodes (9): compilerOptions, noEmit, types, extends, include, jest, tests/**/*.ts, node (+1 more)

### Community 113 - "Community 113"
Cohesion: 0.17
Nodes (3): ActiveDeviceCache, normalizeActiveDevice(), LocalActiveDeviceStore

### Community 114 - "Community 114"
Cohesion: 0.44
Nodes (8): getLocalPublishHashCache(), clearAllPublishHashesForDevice(), clearPublishHash(), hashPayload(), publishForce(), publishHashRedisKey(), publishIfChanged(), stableJson()

### Community 115 - "Community 115"
Cohesion: 0.50
Nodes (3): CI validate-env, Configuration matrix, Feature env gates (in-process)

### Community 116 - "Community 116"
Cohesion: 0.29
Nodes (7): Dashboard → user, Device AP — `POST /api/recovery/restore`, Device → MQTT — `POST /api/v1/certificates/reissue`, Device recovery API (firmware contract), Environment, Errors (firmware handling), MQTT — register session (dashboard proxy only)

### Community 117 - "Community 117"
Cohesion: 0.36
Nodes (7): express, express, getSwaggerSpec(), resetSwaggerSpecCache(), resolveApiGlobs(), setupSwaggerUi(), swaggerDefinition

### Community 118 - "Community 118"
Cohesion: 0.22
Nodes (9): Conservative Estimate for Pilot v1, Current Code-Derived Limits, Fleet Capacity Documentation, Gaps to Address Post-Pilot, Operational Recommendations, Performance Notes, Reconnect storm (manual / scheduled), Redis Storage Limits (+1 more)

### Community 119 - "Community 119"
Cohesion: 0.22
Nodes (9): App runtime & metrics, 🔧 Configuration, Core (MQTT & HTTP), Feature flags (all default `true`), Integrations, Legacy environment names (deprecated), MongoDB connection pool, MQTT TLS / mTLS (production) (+1 more)

### Community 122 - "🚀 MQTT Publisher Lite"
Cohesion: 0.22
Nodes (9): 🏗️ Architecture, 📊 Comparison with Full Version, 📚 Documentation, ✨ Features, 📄 License, 🚀 MQTT Publisher Lite, 🚂 Railway Deployment, 🤝 Support (+1 more)

### Community 123 - "tsconfig.eslint.json"
Cohesion: 0.22
Nodes (8): exclude, extends, include, dist, node_modules, src/**/*, tests/**/*, ./tsconfig.json

### Community 124 - "Community 124"
Cohesion: 0.25
Nodes (11): main(), main(), mongodbSrvHostname(), sanitizeUri(), validateUriShape(), mongoDriverTimeouts(), colors, main() (+3 more)

### Community 125 - "AppConfig"
Cohesion: 0.50
Nodes (4): 1. Architecture, Problems, Strengths, What it is

### Community 126 - "gmb-pubsub.ts"
Cohesion: 0.44
Nodes (5): extractBearerToken(), getGmbPubsubAudience(), verifyPubSubPushRequest(), GmbPubsubVerifyConfig, PubSubPushVerificationResult

### Community 129 - "Community 129"
Cohesion: 0.33
Nodes (6): Code references, Health and readiness, Phase A — Operations and configuration hardening, Serverless endpoint (required for poller), Smoke, Tunable polling (`InstagramPollingConfig` / `IG_POLL_*`, `IG_FETCH_*`)

### Community 130 - "Community 130"
Cohesion: 0.33
Nodes (6): 1. Check Health, 2. Publish MQTT Message, 3. Subscribe with Mosquitto, 4. Register a Device, 5. Get All Devices, 🧪 Test It Works

### Community 131 - "Community 131"
Cohesion: 0.25
Nodes (8): Broker config (Flow 1), 🧭 Device Lifecycle V5.0 (firmware contract), Firmware flow mapping (V5.0), Flow 2: Seamless Renewal (overlap, MQTT-validated), Flow 4: Factory reset recovery (JWT session + reissue), HTTP endpoints used by firmware, Initial enrollment (existing), mTLS identity for HTTP (proxy mode)

### Community 133 - "chainValidator.ts"
Cohesion: 0.39
Nodes (3): InstagramFetchAuditInfluxInput, ProfileBaselineInfluxInput, InstagramAuditRepo

### Community 134 - "Community 134"
Cohesion: 0.33
Nodes (6): 🔧 Connection Methods, Environment Variable:, Environment Variables:, Example Redis Cloud URL:, Method 1: Using Redis URL (Recommended for Redis Cloud), Method 2: Using Individual Parameters (with TLS)

### Community 135 - "Community 135"
Cohesion: 0.29
Nodes (5): Actions, Impact (pilot), Redis down, Related, Symptoms

### Community 136 - "Community 136"
Cohesion: 0.29
Nodes (7): 📡 API Endpoints, Create Session, Create User, Get All Devices, Health Check, Publish MQTT Message, Register Device

### Community 137 - "Community 137"
Cohesion: 0.43
Nodes (4): getReview(), listReviews(), ListReviewsResponse, mapGmbStarRating()

### Community 138 - "Community 138"
Cohesion: 0.33
Nodes (6): Option A: Using URL (Easiest), Option B: Using Individual Parameters, 📋 Redis Cloud Setup Steps, Step 1: Get Your Redis Cloud Connection Details, Step 2: Configure Environment Variables, Step 3: Deploy

### Community 139 - "Community 139"
Cohesion: 0.33
Nodes (5): Capacity, Deferred queue backlog / stale drops, Log contract (alert-ready), Policy (Phase 0), Rollback

### Community 140 - "Community 140"
Cohesion: 0.33
Nodes (5): ✅ Already Implemented, Key Files to Examine, Next Steps, ❌ Not Implemented, Summary

### Community 141 - "Community 141"
Cohesion: 0.33
Nodes (5): Bun Runtime Security Notes, Known Risks, Mitigations, Monitoring, Version Policy

### Community 142 - "Community 142"
Cohesion: 0.07
Nodes (33): main(), parseArgs(), sha256Hex(), OtaOciConfig, otaOciParBaseUrl(), createFirmwareStorageService(), metaValue(), OciFirmwareStorageService (+25 more)

### Community 143 - "Community 143"
Cohesion: 0.33
Nodes (6): Common Name, CSR Format, Key Type, Public Key, Signature Algorithm, ✅ Validation Checklist

### Community 144 - "Community 144"
Cohesion: 0.33
Nodes (6): ✅ **Common Name (CN) = device_id**, ✅ **CSR Format: PEM (PKCS#10)**, ✅ **Key Type: ECC (P-256 / secp256r1)**, ✅ **Public Key in CSR**, ✅ **Signature Algorithm: ECDSA + SHA-256**, 📋 Your Requirements

### Community 145 - "campaignSchedule.ts"
Cohesion: 0.40
Nodes (5): 1. Generate CSR Locally, 2. Verify CSR Format, 3. Extract Public Key, 4. Test with Server, 🧪 Testing Your CSR

### Community 146 - "gmbSocial.ts"
Cohesion: 0.33
Nodes (6): HTTP server, MQTT push, OTA download / verify, Serial port / flash, Troubleshooting, WiFi

### Community 147 - "Community 147"
Cohesion: 0.33
Nodes (5): MQTT_BROKER, MQTT_PORT, MQTT_TLS_REJECT_UNAUTHORIZED, OTA_FIRMWARE_VERSION, run-e2e.sh script

### Community 149 - "husky.sh"
Cohesion: 0.33
Nodes (5): DeviceInfo, MqttMessage, PublishOptions, SessionInfo, UserInfo

### Community 150 - "post-applypatch"
Cohesion: 0.40
Nodes (5): CSR Parsing, CSR Signature Verification, Device ID Validation, Public Key Extraction, 🔍 Server Implementation Details

### Community 152 - "post-commit"
Cohesion: 0.40
Nodes (5): 1. Install Dependencies, 2. Configure, 3. Run, 4. Test, 📋 Quick Start

### Community 153 - "sign-firmware.ts"
Cohesion: 0.40
Nodes (5): Can't connect to MQTT broker, Data not persisting, MQTT messages not received, Port 3002 already in use, 🐛 Troubleshooting

### Community 154 - "Manual Testing"
Cohesion: 0.40
Nodes (5): Manual Testing, Run Tests, Test MQTT Connection, Test WebSocket, 🧪 Testing

### Community 155 - "OtaTelemetryRepo"
Cohesion: 0.40
Nodes (4): sha256, signature, size_bytes, version

### Community 156 - "Community 156"
Cohesion: 0.60
Nodes (3): verify-broker-tls.sh script, usage(), verify_one()

### Community 157 - "influxConfig.test.ts"
Cohesion: 0.40
Nodes (4): Behaviour, Cloud / local config, Removal Checklist (after testing), stimulate/ — TEMP Testing-Phase (in-process)

### Community 158 - "applypatch-msg"
Cohesion: 0.33
Nodes (5): E2E HTTP flow tests, Environment, Flows covered, Manual MQTT / device E2E, Run

### Community 159 - "commit-msg"
Cohesion: 0.40
Nodes (5): Issue: Authentication Failed, Issue: Connection Refused, Issue: Connection Timeout, Issue: TLS Handshake Failed, 🚨 Troubleshooting

### Community 160 - "husky.sh"
Cohesion: 0.33
Nodes (5): Actions, Causes, Cert lookup 503, Related, Symptoms

### Community 161 - "Community 161"
Cohesion: 0.40
Nodes (4): express-serve-static-core, http, IncomingMessage, Request

### Community 164 - "Community 164"
Cohesion: 0.50
Nodes (4): 2. Security — the good, the bad, the ugly, Bad, Good, Ugly (corrected from prior drafts)

### Community 169 - "pre-auto-gc"
Cohesion: 0.50
Nodes (4): Build, Docker Compose, 🐳 Docker Usage, Run

### Community 170 - "pre-commit"
Cohesion: 0.50
Nodes (4): devices.json, sessions.json, 📂 Storage, users.json

### Community 171 - "shouldSkipForStimulate"
Cohesion: 0.50
Nodes (3): Layout, Notes, PKI scripts

### Community 172 - "pre-push"
Cohesion: 0.83
Nodes (3): cleanup_stale_jest(), on_interrupt(), run-unit-tests.sh script

### Community 173 - "pre-merge-commit"
Cohesion: 0.25
Nodes (5): Actions, Causes, OTA webhook reject, Symptoms, Runbooks — ProofMQTT operations

### Community 176 - "pre-rebase"
Cohesion: 0.67
Nodes (3): Add New Functionality, 📝 Development, Project Structure

### Community 177 - "prepare-commit-msg"
Cohesion: 0.67
Nodes (3): Certificate revocation (NanoMQ), Pilot v1 hardening, 🔐 Security & limitations (V5.0)

### Community 184 - "promotionConfig.ts"
Cohesion: 0.50
Nodes (3): correlation_id: tag → field (dual-write window), InfluxDB Flux Partner Migration Guide, PKI audit verification

## Knowledge Gaps
- **1013 isolated node(s):** `railway`, `root`, `parser`, `@typescript-eslint`, `eslint:recommended` (+1008 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **62 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `logger` connect `Community 29` to `Community 0`, `Community 1`, `Community 2`, `Community 7`, `Community 9`, `Community 11`, `Community 12`, `Community 142`, `Community 15`, `Community 17`, `Community 20`, `Community 21`, `Community 28`, `Community 31`, `Community 33`, `Community 34`, `Community 35`, `Community 36`, `Community 39`, `Community 40`, `Community 41`, `Community 51`, `Community 56`, `Community 57`, `Community 61`, `Community 62`, `Community 66`, `Community 68`, `Community 74`, `Community 75`, `Community 83`, `Community 84`, `Community 91`, `Community 92`, `Community 103`?**
  _High betweenness centrality (0.056) - this node is a cross-community bridge._
- **Why does `InfluxService` connect `Community 4` to `Community 128`, `Community 1`, `Community 162`, `Community 35`, `Community 163`, `post-commit`, `post-merge`, `Community 39`, `chainValidator.ts`, `Community 69`, `post-rewrite`, `Community 107`, `Community 12`, `Community 108`, `Community 106`, `Community 85`, `Community 28`, `Community 127`?**
  _High betweenness centrality (0.042) - this node is a cross-community bridge._
- **Why does `dependencies` connect `Community 14` to `uuid`, `Community 60`, `Community 117`?**
  _High betweenness centrality (0.034) - this node is a cross-community bridge._
- **What connects `railway`, `root`, `parser` to the rest of the system?**
  _1013 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.06721311475409836 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.1073170731707317 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.08108108108108109 - nodes in this community are weakly interconnected._