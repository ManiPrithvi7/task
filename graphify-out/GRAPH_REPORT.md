# Graph Report - proofmqtt  (2026-07-29)

## Corpus Check
- 284 files · ~152,571 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2482 nodes · 4940 edges · 192 communities (131 shown, 61 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 26 edges (avg confidence: 0.58)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `0e6c56a3`
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
- Community 122
- Community 123
- Community 124
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
- Community 145
- Community 146
- Community 147
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
- pre-push
- pre-rebase
- prepare-commit-msg
- prettier
- supertest
- @types/compression
- @types/cors
- @types/express
- @types/jsonwebtoken
- @types/node-forge
- @types/supertest
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

## God Nodes (most connected - your core abstractions)
1. `StatsMqttLite` - 75 edges
2. `logger` - 73 edges
3. `InfluxService` - 67 edges
4. `getRedisService()` - 59 edges
5. `Device` - 52 edges
6. `MqttClientManager` - 47 edges
7. `OtaService` - 41 edges
8. `OtaRedisState` - 34 edges
9. `CAService` - 31 edges
10. `getActiveDeviceCache()` - 29 edges

## Surprising Connections (you probably didn't know these)
- `normalizeResponseBody()` --indirect_call--> `key()`  [INFERRED]
  src/services/instagramService.ts → stimulate/cache.ts
- `main()` --calls--> `loadConfig()`  [EXTRACTED]
  scripts/ota/upload-firmware-oci.ts → src/config/index.ts
- `main()` --calls--> `loadConfig()`  [EXTRACTED]
  scripts/test-mqtt-mtls.ts → src/config/index.ts
- `buildConfigRoutesApp()` --calls--> `createConfigRoutes()`  [EXTRACTED]
  tests/unit/routes/configRoutes.test.ts → src/routes/configRoutes.ts
- `app()` --calls--> `createConnectionsRoutes()`  [EXTRACTED]
  tests/unit/routes/connectionsRoutes.test.ts → src/routes/connectionsRoutes.ts

## Import Cycles
- None detected.

## Communities (192 total, 61 thin omitted)

### Community 1 - "Community 1"
Cohesion: 0.06
Nodes (11): httpRequestDuration, httpRequestsTotal, metricsHandler(), metricsMiddleware(), register, HttpServer, DeviceService, SessionService (+3 more)

### Community 2 - "Community 2"
Cohesion: 0.05
Nodes (46): abandonAttentionCorrelation(), applyInstagramServerlessDeviceOutcome(), areInstagramPollingScriptsLoaded(), atomicBackoffCheckAndRecordLua, atomicFetchBudgetTryLua, atomicPriorityReadAndPruneLua, AttentionE2eLatencySnapshot, buildLatencySnapshot() (+38 more)

### Community 3 - "Community 3"
Cohesion: 0.08
Nodes (26): InfluxDBConfig, GmbReviewSnapshotInfluxInput, GmbVelocityWeeklyInfluxInput, GmbWebhookAuditInfluxInput, InstagramCircuitEventInfluxInput, InstagramMilestoneCrossedInfluxInput, InstagramMqttDeliveryInfluxInput, MilestoneCrossedInfluxInput (+18 more)

### Community 4 - "Community 4"
Cohesion: 0.23
Nodes (11): ensureFreshInstagramAccessToken(), InstagramTokenContext, loadInstagramTokenContextForUser(), getActiveDeviceCache(), ActiveSetRedisClient, devicesNeedingHydration(), HydrateActiveDeviceFn, republishCachedScreensForActiveDevices() (+3 more)

### Community 5 - "Community 5"
Cohesion: 0.10
Nodes (21): 1. Generate CSR Locally, 2. Verify CSR Format, 3. Extract Public Key, 4. Test with Server, 📊 Comparison: Your Spec vs Server Support, CSR Requirements Validation, 📝 Example: ESP32 CSR Generation, ✅ Final Verdict (+13 more)

### Community 6 - "Community 6"
Cohesion: 0.15
Nodes (32): Campaign, invalidateCanvasCache(), asCampaignForSchedule(), campaignSocialIdFilter(), fanoutPromotionToUserDevices(), filterSchedulableCampaigns(), getEligibleCampaignsForUser(), getNextPromotionIndex() (+24 more)

### Community 7 - "Community 7"
Cohesion: 0.06
Nodes (34): 📚 Additional Resources, After (Redis Cloud):, Before (Local):, Best Practices, Check Logs, Connection Flow, 🔧 Connection Methods, Environment Variable: (+26 more)

### Community 8 - "Community 8"
Cohesion: 0.13
Nodes (22): processRollouts(), RolloutSchedulerHandle, dashboardLink(), formatText(), sendOtaSlackAlert(), SlackOtaAlertKind, SlackOtaAlertPayload, canAdvanceStage() (+14 more)

### Community 9 - "Community 9"
Cohesion: 0.09
Nodes (35): FirmwareReleaseSchema, FirmwareReleaseStatus, FirmwareRolloutSchema, FirmwareRolloutStrategy, IFirmwareRollout, createOtaAdminRoutes(), requireAdminAuth(), ObjectHeadResult (+27 more)

### Community 10 - "Community 10"
Cohesion: 0.18
Nodes (9): FirmwareRelease, IFirmwareRelease, OtaService, deviceHashBucket(), compareVersions(), isVersionGreater(), mockLogEvent, mockStorage (+1 more)

### Community 11 - "Community 11"
Cohesion: 0.06
Nodes (34): 1.1 Webhook Routes (`/api/webhooks/*`), 1.2 Promotion Routes (`/api/v1/promotions/*`), 1.3 Connections Routes (`/api/v1/connections/*`), 2.1 Device OTA Routes (`/api/v1/ota/*`), 2.2 Admin OTA Routes (`/api/v1/admin/ota/*`), 3.1 Provisioning Routes (`/api/v1/onboarding/*`), 3.2 Config Routes (`/api/v1/config/*`), 3.3 Lifecycle Routes (`/api/v1/lifecycle/*`) (+26 more)

### Community 12 - "Community 12"
Cohesion: 0.06
Nodes (26): StatsMqttLite, startRolloutScheduler(), backfillFirmwareReleaseStageFields(), createMongoService(), BufferedMqttMessage, flushMessageBuffer(), handleCritical(), handleNonCritical() (+18 more)

### Community 13 - "Community 13"
Cohesion: 0.12
Nodes (17): Architecture (what you are testing), ESP32 OTA End-to-End Manual Test Guide, Files in this repo, MQTT topics (must match server `MQTT_TOPIC_ROOT`), OTA command payload (server → device), Quick reference (3 terminals), Related docs, Short checklist (9 steps) (+9 more)

### Community 14 - "Community 14"
Cohesion: 0.10
Nodes (21): compression, cors, dotenv, googleapis, mqtt, dependencies, compression, cors (+13 more)

### Community 15 - "Community 15"
Cohesion: 0.05
Nodes (38): 0. CONTEXT & PROJECT UNDERSTANDING, 1.1 H-1: mTLS Fingerprint Binding at HTTP Edge, 1.2 H-2: Admin JWT Scope Hardening (Interim → Permanent), 1.3 DEV-1: Keep Dev OTA Route — Rename for Pilot v1, 1.4 M-1: Remove WebSocket Server Completely, 1.5 M-2: Trim Health Endpoint Information Disclosure, 1.6 M-3: CORS Origin Restriction, 1.7 M-4: CSR Rate Limiter — Fallback to Local Cache (+30 more)

### Community 16 - "Community 16"
Cohesion: 0.05
Nodes (42): 10. Daily Metrics — POS Order Tracking, 11. Connect Refresh Coordinator, 12. GMB Review Cache, 1. OtaRedisState — OTA Coordination, 2. Instagram Polling & Lua Scripts, 3. RecoverySessionService — Factory Reset Sessions, 4. PromotionService — Campaign Cache, 5. BrandCanvasService — Ad Cache (+34 more)

### Community 18 - "Community 18"
Cohesion: 0.12
Nodes (27): buildObjectKey(), buildParUrl(), { common, objectstorage }, createOciClient(), createOciDownloadUrl(), hasOciEnvCredentials(), normalizePem(), OTA_PRESIGNED_TTL_SEC (+19 more)

### Community 19 - "Community 19"
Cohesion: 0.16
Nodes (9): DeviceCertificate, DeviceCertificateSchema, DeviceCertificateSlot, DeviceCertificateStatus, IDeviceCertificate, CAConfig, CAService, NOTE: Some deployments may still have a legacy UNIQUE index on { device_id } (no (+1 more)

### Community 20 - "Community 20"
Cohesion: 0.12
Nodes (8): OtaConfig, OtaDownloadMode, OtaAdminRoutesDeps, getAuditService(), IFirmwareStorage, computeSigningKeyFingerprint(), OtaCommandPublisher, initOtaSigningKeyAudit()

### Community 21 - "Community 21"
Cohesion: 0.17
Nodes (14): nsToMs(), WebhookLatencyStages, WebhookLatencyTracker, WebhookProvider, tryClaimWebhookDedupe(), ack(), handleGmbWebhook(), parseStarRating() (+6 more)

### Community 22 - "Community 22"
Cohesion: 0.07
Nodes (30): bun-types, ES2020, stimulate/**/*, **/*.test.ts, compilerOptions, allowSyntheticDefaultImports, baseUrl, declaration (+22 more)

### Community 23 - "Community 23"
Cohesion: 0.05
Nodes (36): Close-out Checklist, Completed: P3.1 - Fleet Capacity Documentation, Completed: P3.2 - Prometheus Alerts, Completed: P3.3 - Global Rate Limiting, Completed: P3.4 - Compliance Documentation, Completed: P3.7 - Security Audit Checklist, Current (2026-07-02), Detailed Roadmap (+28 more)

### Community 24 - "Community 24"
Cohesion: 0.11
Nodes (20): ACLRule, ACLRuleSchema, DeviceACL, DeviceACLSchema, DeviceTier, IDeviceACL, IGoogleBusinessLocation, IGoogleBusinessProfile (+12 more)

### Community 25 - "Community 25"
Cohesion: 0.14
Nodes (14): Attention polling — implementation status, Code references, Dual schedulers — priority and background (both implemented), Intended flow (device scan / NFC), Phase B — Attention / priority signals, Phase C — Fairness, starvation, budgets, Phase D — Observability, Phase E — Topology & dedupe (+6 more)

### Community 26 - "Community 26"
Cohesion: 0.22
Nodes (5): chunk(), evalAtomicBackoffCheckAndRecordEvalSha(), igPollMetricsInc(), InstagramPoller, shouldSkipForStimulate()

### Community 27 - "Community 27"
Cohesion: 0.14
Nodes (13): 🎯 Behavior After Fix, 📋 Environment Variables, 🔍 Files Modified, 🐛 Problem, Redis Connection Fix - Deployment Issue Resolution, 🎉 Result, Root Causes, ✅ Testing (+5 more)

### Community 28 - "Community 28"
Cohesion: 0.07
Nodes (26): Actual Retention Mechanism, Appendices, Appendix A: Retention Policy History, Appendix B: Cost Tracking, Application Configuration, Architecture, Compliance Considerations, Conclusion (+18 more)

### Community 29 - "Community 29"
Cohesion: 0.10
Nodes (19): App Wiring (`src/app.ts`), Audit Events (`src/services/auditService.ts`), Code Gaps, Config (`src/config/index.ts`), Docs, Fixes, InfluxDB Refinement Actions, InfluxService (`src/services/influxService.ts`) (+11 more)

### Community 30 - "Community 30"
Cohesion: 0.19
Nodes (16): CampaignSchema, CampaignStatus, DiscountType, ICampaign, ScheduleType, TargetType, Provider, isCampaignActive() (+8 more)

### Community 31 - "Community 31"
Cohesion: 0.15
Nodes (18): buildGmbScreenPayload(), buildInstagramScreenPayload(), BuildScreenEnvelopeOpts, CelebrationState, CelebrationType, getInstagramMegaCrossedMilestones(), GmbReviewItem, gmbReviewMetrics() (+10 more)

### Community 32 - "Community 32"
Cohesion: 0.12
Nodes (17): Admin API (Bearer user JWT), CI webhook — automated release + staged rollout, Device HTTP — `GET /api/v1/ota/download/:version` (proxy mode, optional), Device HTTP — `POST /api/v1/ota/report` (optional fallback), Enable OTA, Finalize validation (server), MQTT — device → server telemetry (legacy, non-pilot), MQTT — server → device commands (+9 more)

### Community 33 - "Community 33"
Cohesion: 0.18
Nodes (11): ⚡ 30-Second Setup, Can't connect to MQTT broker?, 📂 Check Your Data, 🔧 Customize, Data not saving?, 📚 Next Steps, Port 3002 in use?, 🚀 Quick Start Guide - MQTT Publisher Lite (+3 more)

### Community 34 - "Community 34"
Cohesion: 0.17
Nodes (12): Admin OTA (interim → planned), Attack surface (production), Change log, Controls verified (positive), Executive summary, POS / integrations webhooks (production today), Production OTA (target state — already implemented except dev route), proofmqtt Security Assessment (+4 more)

### Community 35 - "Community 35"
Cohesion: 0.15
Nodes (23): WebhookConfig, DeviceGmbContext, resolveGmbContextForDevice(), createAccessTokenOAuthClient(), getGmbApiAuth(), GmbApiAuth, gmbApiErrorMeta(), locationCacheKeyFromResourceName() (+15 more)

### Community 36 - "Community 36"
Cohesion: 0.23
Nodes (9): createOtaRoutes(), OtaRoutesDeps, checkOtaRateLimit(), OtaEventHandler, isFirmwareBin(), LocalTestOtaFirmware, resolveLocalTestOtaFirmware(), buildApp() (+1 more)

### Community 38 - "Community 38"
Cohesion: 0.09
Nodes (22): 1.1 Remove Committed Private Keys from Repo, 1.2 Update .env.example with Admin Auth, 1. Immediate (P1 Priority), 2.1 Migrate Runtime to Bun, 2.2 Remove Render Configuration, 2.3 Add ESLint + Prettier, 2. Medium Priority (2-3 days), 3.1 Core Infrastructure (+14 more)

### Community 39 - "Community 39"
Cohesion: 0.18
Nodes (4): InfluxDiskQueue, InfluxDiskQueueOptions, influxWriteErrorMessage(), isPermanentInfluxWriteError()

### Community 40 - "Community 40"
Cohesion: 0.24
Nodes (17): appClientDir, backupIfExists(), caConfig(), caStoragePath, cmdAppClient(), cmdInitCa(), cmdPrintAppEnv(), cmdRotate() (+9 more)

### Community 42 - "Community 42"
Cohesion: 0.14
Nodes (14): scripts, build, check, coverage, dev, format, lint, lint:fix (+6 more)

### Community 44 - "Community 44"
Cohesion: 0.21
Nodes (7): OciFirmwareStorageService, isRetryableOciError(), mapOciError(), OciStorageError, OciStorageErrorCode, statusFromMessage(), withOciRetry()

### Community 45 - "Community 45"
Cohesion: 0.16
Nodes (20): main(), setMqttTlsClientPem(), MessageHandler, MqttConfig, MqttMessage, PendingAck, PublishMetadata, applyMqttJsTlsOptions() (+12 more)

### Community 46 - "Community 46"
Cohesion: 0.13
Nodes (14): **1\. Executive Summary & Design Goals**, **2\. Comprehensive Concept Verification Matrix**, **3.1 Dual-Path Trigger Engine**, **3.2 State Tracking Mechanics**, **3\. Core Subsystem Operations**, **4.1 Cooldown and Blacklist Management**, **4.2 Post-Update Safety Architecture**, **4.3 Handshake Reliability (QoS 1 Application Loop)** (+6 more)

### Community 47 - "Community 47"
Cohesion: 0.18
Nodes (11): DailyMetricsRedisKeys, DateBucketResult, getDailyMetricsKeys(), getDateBucket(), getStartOfDayInTimezone(), getTimezoneOffsetMs(), priceToCents(), resolveMetricsTimezone() (+3 more)

### Community 48 - "Community 48"
Cohesion: 0.13
Nodes (14): **1\. Executive Summary & Design Goals**, **2\. Comprehensive Concept Verification Matrix**, **3.1 Dual-Path Trigger Engine**, **3.2 State Tracking Mechanics**, **3\. Core Subsystem Operations**, **4.1 Cooldown and Blacklist Management**, **4.2 Post-Update Safety Architecture**, **4.3 Handshake Reliability (QoS 1 Application Loop)** (+6 more)

### Community 49 - "Community 49"
Cohesion: 0.22
Nodes (15): Ad, AdSchema, AdStatus, AdType, IAd, NOTE: This is a READ-ONLY model for mqtt-publisher-lite., buildBrandCanvasPayload(), CachedBrandCanvasDto (+7 more)

### Community 50 - "Community 50"
Cohesion: 0.18
Nodes (6): Device, DeviceOtaState, DeviceSchema, DeviceStatus, IDevice, ResolvedDeviceTarget

### Community 51 - "Community 51"
Cohesion: 0.20
Nodes (7): Cleanup checklist (after device test passes), Direct OCI URL (optional sanity check), Download URL for firmware developer, OTA dev download test (temporary), Re-upload firmware to dev bucket, What this does **not** do, What was added (dev only)

### Community 52 - "Community 52"
Cohesion: 0.19
Nodes (16): formatInstagramScreenMqttPayload(), resolveCelebrationState(), buildStimIgPayload(), ensureStimIgLock(), releaseStimIgLock(), resolveLiveFollowersForStim(), runIgTick(), updateFollowerCache() (+8 more)

### Community 53 - "Community 53"
Cohesion: 0.08
Nodes (23): extends, ignorePatterns, dist/, node_modules/, parser, parserOptions, project, plugins (+15 more)

### Community 56 - "Community 56"
Cohesion: 0.23
Nodes (14): extractMtlsIdentityFromNativeTls(), extractMtlsIdentityFromProxy(), findActiveCertForSlots(), firstHeader(), MtlsCertSlot, MtlsIdentity, normalizeFingerprint(), normalizeForwardedPem() (+6 more)

### Community 57 - "Community 57"
Cohesion: 0.21
Nodes (12): deprecatedWarned, envBool(), envInt(), envString(), resolveMqttClientId(), warnDeprecatedEnv(), loadConfig(), loadOciCredentialsFromEnv() (+4 more)

### Community 58 - "Community 58"
Cohesion: 0.11
Nodes (27): AppEnvConfig, AppFeaturesConfig, AuthConfig, decodeBase64ToUtf8(), DEFAULT_PROVISIONING_CA_STORAGE_PATH, describePrivateKeyPemKind(), firstPemEnv(), getProvisioningRootCaCertFromEnv() (+19 more)

### Community 59 - "Community 59"
Cohesion: 0.19
Nodes (13): GoogleBusinessReview, GoogleBusinessReviewSchema, IGoogleBusinessReview, sha256Payload(), GmbFastScreenInput, GmbScreenAuditContext, GmbScreenPublishResult, publishGmbScreen() (+5 more)

### Community 60 - "Community 60"
Cohesion: 0.33
Nodes (5): engines, bun, name, type, version

### Community 61 - "Community 61"
Cohesion: 0.22
Nodes (9): 🏗️ Architecture, 📊 Comparison with Full Version, 📚 Documentation, ✨ Features, 📄 License, 🚀 MQTT Publisher Lite, 🚂 Railway Deployment, 🤝 Support (+1 more)

### Community 62 - "Community 62"
Cohesion: 0.17
Nodes (16): checkLocalShortCircuit(), csrRateLimiter(), DEFAULT_CONFIG, incrementLocalCounter(), localCounters, RateLimitConfig, rejectRateLimited(), resetCsrLocalCounters() (+8 more)

### Community 63 - "Community 63"
Cohesion: 0.07
Nodes (27): 10. Verdict table, 11. Bottom line, 1. Architecture, 2. Security — the good, the bad, the ugly, 3. OTA subsystem — ambitious and footgun-prone, 4. Database and storage choices, 5. Configuration — env variable hell, 6. Testing — thin for size, not absent (+19 more)

### Community 64 - "Community 64"
Cohesion: 0.24
Nodes (5): main(), OCI_PYTHON_SDK_CONNECTION_TIMEOUT, OCI_PYTHON_SDK_READ_TIMEOUT, instance.sh script, write_metadata()

### Community 65 - "Community 65"
Cohesion: 0.14
Nodes (19): computeAudience(), main(), loadWebhookConfig(), WebhookDeviceTarget, captureRawBody, createWebhookRoutes(), extractBearerToken(), gmbLimiter (+11 more)

### Community 66 - "Community 66"
Cohesion: 0.22
Nodes (9): App runtime & metrics, 🔧 Configuration, Core (MQTT & HTTP), Feature flags (all default `true`), Integrations, Legacy environment names (deprecated), MongoDB connection pool, MQTT TLS / mTLS (production) (+1 more)

### Community 67 - "Community 67"
Cohesion: 0.20
Nodes (10): createLifecycleRoutes(), httpStatusForRecoveryError(), LifecycleDeps, postRecoveryWebhook(), reissueLimiter, DeviceAlreadyHasCertificateError, UnsupportedCSRKeyTypeError, decodeCsrToPem() (+2 more)

### Community 69 - "Community 69"
Cohesion: 0.47
Nodes (7): clearAllPublishHashesForDevice(), clearPublishHash(), hashPayload(), publishForce(), publishHashRedisKey(), publishIfChanged(), stableJson()

### Community 70 - "Community 70"
Cohesion: 0.25
Nodes (7): Dashboard → user, Device AP — `POST /api/recovery/restore`, Device → MQTT — `POST /api/v1/certificates/reissue`, Device recovery API (firmware contract), Environment, Errors (firmware handling), MQTT — register session (dashboard proxy only)

### Community 71 - "Community 71"
Cohesion: 0.05
Nodes (37): bun-types, eslint, husky, devDependencies, bun-types, eslint, husky, prettier (+29 more)

### Community 72 - "Community 72"
Cohesion: 0.25
Nodes (8): Broker config (Flow 1), 🧭 Device Lifecycle V5.0 (firmware contract), Firmware flow mapping (V5.0), Flow 2: Seamless Renewal (overlap, MQTT-validated), Flow 4: Factory reset recovery (JWT session + reissue), HTTP endpoints used by firmware, Initial enrollment (existing), mTLS identity for HTTP (proxy mode)

### Community 73 - "Community 73"
Cohesion: 0.23
Nodes (13): clearStimCache(), key(), readStimCache(), StimCacheEntry, store, writeStimCache(), ensureStimGmbLock(), releaseStimGmbLock() (+5 more)

### Community 74 - "Community 74"
Cohesion: 0.15
Nodes (13): Abort, Admin APIs, `can_advance`, CI webhooks, Device failure reasons, Env, Hash algorithm (FW-4), MQTT `ota_update` (FW-4) (+5 more)

### Community 75 - "Community 75"
Cohesion: 0.20
Nodes (8): fetchInstagramProfileMetrics(), InstagramProfileFetchAudit, InstagramProfileFetchError, InstagramProfileFetchResult, InstagramProfileMetrics, sha256Hex(), fetchInstagramMetrics(), sleep()

### Community 76 - "Community 76"
Cohesion: 0.13
Nodes (21): ALLOWED_FLUX_FUNCTIONS, extractFunctionCalls(), KNOWN_MEASUREMENTS, sanitizeFluxQuery(), SanitizeResult, createDashboardRoutes(), DashboardRoutesDeps, requireAuth() (+13 more)

### Community 77 - "Community 77"
Cohesion: 0.25
Nodes (11): main(), parseArgs(), sha256Hex(), OtaOciConfig, createFirmwareStorageService(), FirmwareStorageService, metaValue(), createOciAuthProvider() (+3 more)

### Community 78 - "Community 78"
Cohesion: 0.18
Nodes (6): InstagramServerlessConfig, InstagramDirectFetchInvoker, InstagramFetchInvoker, InstagramServerlessBridge, normalizeResponseBody(), parseDeviceRow()

### Community 79 - "Community 79"
Cohesion: 0.40
Nodes (4): Behaviour, Cloud / local config, Removal Checklist (after testing), stimulate/ — TEMP Testing-Phase (in-process)

### Community 80 - "Community 80"
Cohesion: 0.29
Nodes (7): 📡 API Endpoints, Create Session, Create User, Get All Devices, Health Check, Publish MQTT Message, Register Device

### Community 81 - "Community 81"
Cohesion: 0.12
Nodes (6): AuditService, getInfluxService(), createTransparencyLog(), TransparencyLog, TransparencyLogConfig, TransparencyProof

### Community 82 - "Community 82"
Cohesion: 0.25
Nodes (4): HTTPServer, Handler, ReuseHTTPServer, SimpleHTTPRequestHandler

### Community 84 - "Community 84"
Cohesion: 0.17
Nodes (11): ACLCacheEntry, ACLRule, ACLStats, ACLValidationResult, CertificateInfo, DeviceACL, DeviceConnectionInfo, DeviceTier (+3 more)

### Community 85 - "Community 85"
Cohesion: 0.22
Nodes (11): main(), mongodbSrvHostname(), sanitizeUri(), validateUriShape(), mongoDriverTimeouts(), MongoConfig, colors, main() (+3 more)

### Community 86 - "Community 86"
Cohesion: 0.47
Nodes (5): DeviceCertSlot, DeviceCertStatus, isUniqueDeviceIdIndex(), main(), requireEnv()

### Community 87 - "Community 87"
Cohesion: 0.15
Nodes (18): LoopState, parseGmbTarget(), parseIgTarget(), parseIntervalMs(), parsePlatforms(), parseStep(), refreshStimLock(), StartDeps (+10 more)

### Community 88 - "Community 88"
Cohesion: 0.20
Nodes (9): jest, tests/**/*.ts, compilerOptions, noEmit, types, extends, include, node (+1 more)

### Community 89 - "Community 89"
Cohesion: 0.20
Nodes (10): DEV-1: Unauthenticated dev OTA download (accepted temporary), Findings, H-1: mTLS identity from proxy header without fingerprint binding, H-2: OTA admin — any valid user JWT (interim), L-1: Static firmware testing UI, L-2: `/health` device enumeration (aggregate only), M-1: WebSocket `/ws` mirrors all MQTT traffic, M-2: Operational information disclosure (+2 more)

### Community 91 - "Community 91"
Cohesion: 0.32
Nodes (6): IUser, NOTE: This is a READ-ONLY model for mqtt-publisher-lite., User, UserSchema, DeviceVerificationResult, UserVerificationResult

### Community 92 - "Community 92"
Cohesion: 0.35
Nodes (7): DeviceOtaEventInput, DeviceOtaEventsRepo, influxNsFromDate(), isValidInfluxNs(), normalizeInfluxTimestamp(), parseLineProtocolTimestampNs(), sanitizeInfluxLineProtocol()

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
Nodes (8): Conservative Estimate for Pilot v1, Current Code-Derived Limits, Fleet Capacity Documentation, Gaps to Address Post-Pilot, Operational Recommendations, Performance Notes, Redis Storage Limits, Scaling Considerations

### Community 97 - "Community 97"
Cohesion: 0.40
Nodes (5): Manual Testing, Run Tests, Test MQTT Connection, Test WebSocket, 🧪 Testing

### Community 98 - "Community 98"
Cohesion: 0.24
Nodes (9): getClaimBaseUrl(), resolveConnectionsValidateApiKey(), ConnectionsRoutesDeps, createConnectionsRoutes(), PROVIDER_MAP, VALID_EVENTS, buildCampaignPayload(), ConnectionValidateEvent (+1 more)

### Community 100 - "Community 100"
Cohesion: 0.83
Nodes (3): cleanup_stale_jest(), on_interrupt(), run-unit-tests.sh script

### Community 101 - "Community 101"
Cohesion: 0.25
Nodes (8): getGmbAccountLookupValues(), GmbReviewNotification, GmbReviewPayload, mapReviewPayloadToStorage(), ResolveGmbReviewPayloadOptions, buildGmbDedupeKey(), GmbReviewNotification, SUPPORTED_GMB_EVENT_TYPES

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
Cohesion: 0.50
Nodes (5): extractBearerToken(), getGmbPubsubAudience(), verifyPubSubPushRequest(), GmbPubsubVerifyConfig, PubSubPushVerificationResult

### Community 109 - "Community 109"
Cohesion: 0.33
Nodes (6): Code references, Health and readiness, Phase A — Operations and configuration hardening, Serverless endpoint (required for poller), Smoke, Tunable polling (`InstagramPollingConfig` / `IG_POLL_*`, `IG_FETCH_*`)

### Community 110 - "Community 110"
Cohesion: 0.67
Nodes (3): Add New Functionality, 📝 Development, Project Structure

### Community 111 - "Community 111"
Cohesion: 0.33
Nodes (6): 1. Check Health, 2. Publish MQTT Message, 3. Subscribe with Mosquitto, 4. Register a Device, 5. Get All Devices, 🧪 Test It Works

### Community 112 - "Community 112"
Cohesion: 0.07
Nodes (37): RFC-5280, app, shutdown(), correlationIdMiddleware(), HttpConfig, AuditEntry, AuditEventType, AuditLogData (+29 more)

### Community 113 - "Community 113"
Cohesion: 0.33
Nodes (6): HTTP server, MQTT push, OTA download / verify, Serial port / flash, Troubleshooting, WiFi

### Community 116 - "Community 116"
Cohesion: 0.48
Nodes (4): buildOtaProxyDownloadUrl(), otaOciParBaseUrl(), resolveOtaDownloadMode(), resolveOtaPublicBaseUrl()

### Community 119 - "Community 119"
Cohesion: 0.48
Nodes (5): bearerToken(), createRecoveryRoutes(), RecoveryRoutesDeps, buildRecoveryRoutesApp(), mockFindOne

### Community 123 - "Community 123"
Cohesion: 0.15
Nodes (7): OTA Download Endpoint, Pilot v1 Exceptions, Health, Production setup, Scope, Shadow mode, Webhook → MQTT (GMB MVP)

### Community 124 - "Community 124"
Cohesion: 0.33
Nodes (5): MQTT_BROKER, MQTT_PORT, MQTT_TLS_REJECT_UNAUTHORIZED, OTA_FIRMWARE_VERSION, run-e2e.sh script

### Community 126 - "Community 126"
Cohesion: 0.33
Nodes (7): express, express, getSwaggerSpec(), resetSwaggerSpecCache(), resolveApiGlobs(), setupSwaggerUi(), swaggerDefinition

### Community 127 - "Community 127"
Cohesion: 0.67
Nodes (4): AppConfig, ConfigRoutesDeps, createConfigRoutes(), buildConfigRoutesApp()

### Community 128 - "Community 128"
Cohesion: 0.50
Nodes (4): Device firmware config (mqttclient), Hardware & host, Prerequisites, Repos & tools

### Community 129 - "Community 129"
Cohesion: 0.50
Nodes (4): Production commands, Production OCI flow (server + Oracle Object Storage), Production verification checklist, Server prerequisites

### Community 130 - "Community 130"
Cohesion: 0.33
Nodes (5): DeviceInfo, MqttMessage, PublishOptions, SessionInfo, UserInfo

### Community 131 - "Community 131"
Cohesion: 0.33
Nodes (5): ✅ Already Implemented, Key Files to Examine, Next Steps, ❌ Not Implemented, Summary

### Community 132 - "Community 132"
Cohesion: 0.33
Nodes (5): Bun Runtime Security Notes, Known Risks, Mitigations, Monitoring, Version Policy

### Community 133 - "chainValidator.ts"
Cohesion: 0.48
Nodes (5): createProvisioningRoutes(), getTokenErrorCode(), ProvisioningDependencies, IMPORTANT: bind the token to the certificate being downloaded., buildProvisioningRoutesApp()

### Community 134 - "Community 134"
Cohesion: 0.40
Nodes (4): Based on current codebase post-Phase 2 - NOT a pentest snapshot, Last Updated: 2026-07-02 (Phase 2 completion), Previous Pentest Date: 2026-06-23, Security Audit Checklist

### Community 135 - "Community 135"
Cohesion: 0.17
Nodes (10): Apply with `gh` (from a machine that has local secrets), Branch protection (`main` on proof-firmware), Decisions, Firmware CI — Week 1 `staging` environment, Related, Rotate `OTA_RELEASE_WEBHOOK_SECRET`, Secrets (source map — never commit values), Variables (+2 more)

### Community 136 - "Community 136"
Cohesion: 0.22
Nodes (8): exclude, extends, include, dist, node_modules, src/**/*, tests/**/*, ./tsconfig.json

### Community 137 - "Community 137"
Cohesion: 0.33
Nodes (6): Common Name, CSR Format, Key Type, Public Key, Signature Algorithm, ✅ Validation Checklist

### Community 138 - "Community 138"
Cohesion: 0.40
Nodes (4): sha256, signature, size_bytes, version

### Community 139 - "Community 139"
Cohesion: 0.67
Nodes (3): Certificate revocation (NanoMQ), Pilot v1 hardening, 🔐 Security & limitations (V5.0)

### Community 143 - "Community 143"
Cohesion: 0.60
Nodes (3): verify-broker-tls.sh script, usage(), verify_one()

### Community 145 - "Community 145"
Cohesion: 0.33
Nodes (6): ✅ **Common Name (CN) = device_id**, ✅ **CSR Format: PEM (PKCS#10)**, ✅ **Key Type: ECC (P-256 / secp256r1)**, ✅ **Public Key in CSR**, ✅ **Signature Algorithm: ECDSA + SHA-256**, 📋 Your Requirements

### Community 146 - "Community 146"
Cohesion: 0.40
Nodes (4): express-serve-static-core, http, IncomingMessage, Request

### Community 147 - "Community 147"
Cohesion: 0.33
Nodes (6): 1. Added `isRedisConfigured()` Method, 2. Added Configuration Check in `connect()` Method, 3. Added Configuration Check in `app.ts`, 4. Fixed `disconnect()` Error Handling, 5. Updated Config Validation, ✅ Solution

### Community 148 - "Community 148"
Cohesion: 0.50
Nodes (3): Layout, Notes, PKI scripts

### Community 149 - "husky.sh"
Cohesion: 0.40
Nodes (5): CSR Parsing, CSR Signature Verification, Device ID Validation, Public Key Extraction, 🔍 Server Implementation Details

### Community 150 - "post-applypatch"
Cohesion: 0.40
Nodes (5): Actions required for a **real** OTA release, High-level production path, Original production OTA flow (unchanged), Production download modes, Production env (secrets only — bucket is hardcoded)

### Community 163 - "Community 163"
Cohesion: 0.50
Nodes (4): 1. Boot — `/active` (QoS 1, retain false), 2. OTA failure — `/status` (QoS 1, retain false), Pilot MQTT contract (minimal — firmware v1), Server → device (unchanged)

## Knowledge Gaps
- **850 isolated node(s):** `root`, `parser`, `@typescript-eslint`, `eslint:recommended`, `plugin:@typescript-eslint/recommended` (+845 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **61 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `InfluxService` connect `Community 0` to `Community 3`, `Community 99`, `Community 39`, `Community 108`, `Community 12`, `Community 112`, `Community 92`?**
  _High betweenness centrality (0.052) - this node is a cross-community bridge._
- **Why does `logger` connect `Community 112` to `Community 1`, `Community 2`, `Community 3`, `Community 4`, `chainValidator.ts`, `Community 6`, `Community 8`, `Community 9`, `Community 12`, `Community 19`, `Community 21`, `Community 31`, `Community 35`, `Community 36`, `Community 39`, `Community 45`, `Community 47`, `Community 49`, `Community 50`, `Community 52`, `Community 56`, `Community 57`, `Community 58`, `Community 59`, `Community 62`, `Community 65`, `Community 67`, `Community 73`, `Community 76`, `Community 77`, `Community 81`, `Community 85`, `Community 87`, `Community 91`, `Community 92`, `Community 98`, `Community 119`?**
  _High betweenness centrality (0.049) - this node is a cross-community bridge._
- **Why does `StatsMqttLite` connect `Community 12` to `Community 0`, `Community 1`, `Community 2`, `Community 8`, `Community 10`, `Community 17`, `Community 19`, `Community 20`, `Community 26`, `Community 36`, `Community 37`, `Community 41`, `Community 43`, `Community 45`, `Community 54`, `Community 57`, `Community 68`, `Community 76`, `Community 77`, `Community 78`, `Community 81`, `Community 83`, `Community 87`, `Community 112`, `Community 116`, `Community 125`, `Community 127`?**
  _High betweenness centrality (0.038) - this node is a cross-community bridge._
- **What connects `root`, `parser`, `@typescript-eslint` to the rest of the system?**
  _850 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05012531328320802 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.06090808416389812 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.0517120894479385 - nodes in this community are weakly interconnected._