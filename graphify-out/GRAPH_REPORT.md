# Graph Report - proofmqtt  (2026-07-17)

## Corpus Check
- 260 files · ~131,863 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2266 nodes · 4449 edges · 183 communities (121 shown, 62 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 22 edges (avg confidence: 0.55)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b9e93484`
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
- Community 128
- Community 129
- Community 130
- Community 131
- Community 132
- Community 133
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
- post-merge
- post-rewrite
- pre-applypatch
- pre-auto-gc
- pre-commit
- pre-merge-commit
- pre-push
- pre-push
- pre-rebase
- prepare-commit-msg
- prettier
- supertest
- @types/compression
- @types/cors
- @types/jsonwebtoken
- @types/node
- @types/supertest
- typescript
- @typescript-eslint/eslint-plugin
- @typescript-eslint/parser
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
- prom-client
- uuid

## God Nodes (most connected - your core abstractions)
1. `StatsMqttLite` - 70 edges
2. `logger` - 69 edges
3. `InfluxService` - 63 edges
4. `getRedisService()` - 56 edges
5. `Device` - 52 edges
6. `MqttClientManager` - 49 edges
7. `CAService` - 31 edges
8. `OtaService` - 27 edges
9. `getActiveDeviceCache()` - 26 edges
10. `getInfluxService()` - 25 edges

## Surprising Connections (you probably didn't know these)
- `main()` --calls--> `loadConfig()`  [EXTRACTED]
  scripts/ota/upload-firmware-oci.ts → src/config/index.ts
- `main()` --calls--> `loadConfig()`  [EXTRACTED]
  scripts/test-mqtt-mtls.ts → src/config/index.ts
- `resolveInstagramMeta()` --calls--> `ensureFreshInstagramAccessToken()`  [EXTRACTED]
  stimulate/igRunner.ts → src/lib/socials/instagramTokenRefresh.ts
- `runGmbTick()` --calls--> `resolveGmbContextForDevice()`  [EXTRACTED]
  stimulate/gmbRunner.ts → src/lib/socials/resolveDeviceGmb.ts
- `resolveInstagramMeta()` --references--> `Device`  [EXTRACTED]
  stimulate/igRunner.ts → src/models/Device.ts

## Import Cycles
- None detected.

## Communities (183 total, 62 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.13
Nodes (25): AppEnvConfig, AppFeaturesConfig, AuthConfig, decodeBase64ToUtf8(), DEFAULT_PROVISIONING_CA_STORAGE_PATH, describePrivateKeyPemKind(), firstPemEnv(), getProvisioningRootCaCertFromEnv() (+17 more)

### Community 2 - "Community 2"
Cohesion: 0.17
Nodes (15): shutdown(), clearAllPublishHashesForDevice(), clearPublishHash(), hashPayload(), publishForce(), publishHashRedisKey(), publishIfChanged(), stableJson() (+7 more)

### Community 3 - "Community 3"
Cohesion: 0.06
Nodes (25): ALLOWED_FLUX_FUNCTIONS, extractFunctionCalls(), KNOWN_MEASUREMENTS, sanitizeFluxQuery(), SanitizeResult, createDashboardRoutes(), DashboardRoutesDeps, requireAuth() (+17 more)

### Community 4 - "Community 4"
Cohesion: 0.15
Nodes (13): assertValidSha256Hex(), assertValidVersionFormat(), FinalizeValidationCode, FinalizeValidationError, OtaActiveRelease, OtaEventPayload, OtaReleaseWebhookInput, OtaReleaseWebhookResult (+5 more)

### Community 5 - "Community 5"
Cohesion: 0.05
Nodes (38): 1. Generate CSR Locally, 2. Verify CSR Format, 3. Extract Public Key, 4. Test with Server, Common Name, ✅ **Common Name (CN) = device_id**, 📊 Comparison: Your Spec vs Server Support, CSR Format (+30 more)

### Community 6 - "Community 6"
Cohesion: 0.06
Nodes (33): areInstagramPollingScriptsLoaded(), atomicBackoffCheckAndRecordLua, atomicFetchBudgetTryLua, atomicPriorityReadAndPruneLua, AttentionE2eLatencySnapshot, buildLatencySnapshot(), correlationStartMs, counters (+25 more)

### Community 7 - "Community 7"
Cohesion: 0.06
Nodes (34): 📚 Additional Resources, After (Redis Cloud):, Before (Local):, Best Practices, Check Logs, Connection Flow, 🔧 Connection Methods, Environment Variable: (+26 more)

### Community 8 - "Community 8"
Cohesion: 0.33
Nodes (10): applySocialDisconnected(), cacheKey(), cacheUserIntegrations(), getUserIntegrationsCacheTtlSec(), GmbIntegrationCache, InstagramIntegrationCache, invalidateUserIntegrations(), PosIntegrationCache (+2 more)

### Community 9 - "Community 9"
Cohesion: 0.12
Nodes (13): ObjectHeadResult, FinalizeValidationCode, FinalizeValidationError, FinalizeValidationInput, OtaActiveRelease, OtaEventHandler, OtaEventPayload, OtaReleaseWebhookInput (+5 more)

### Community 10 - "Community 10"
Cohesion: 0.12
Nodes (27): buildObjectKey(), buildParUrl(), { common, objectstorage }, createOciClient(), createOciDownloadUrl(), hasOciEnvCredentials(), normalizePem(), OTA_PRESIGNED_TTL_SEC (+19 more)

### Community 11 - "Community 11"
Cohesion: 0.06
Nodes (34): 1.1 Webhook Routes (`/api/webhooks/*`), 1.2 Promotion Routes (`/api/v1/promotions/*`), 1.3 Connections Routes (`/api/v1/connections/*`), 2.1 Device OTA Routes (`/api/v1/ota/*`), 2.2 Admin OTA Routes (`/api/v1/admin/ota/*`), 3.1 Provisioning Routes (`/api/v1/onboarding/*`), 3.2 Config Routes (`/api/v1/config/*`), 3.3 Lifecycle Routes (`/api/v1/lifecycle/*`) (+26 more)

### Community 12 - "Community 12"
Cohesion: 0.07
Nodes (21): RFC-5280, StatsMqttLite, ChainValidationResult, isChainValid(), validateCertificateChain(), BufferedMqttMessage, flushMessageBuffer(), handleCritical() (+13 more)

### Community 13 - "Community 13"
Cohesion: 0.12
Nodes (17): Architecture (what you are testing), ESP32 OTA End-to-End Manual Test Guide, Files in this repo, MQTT topics (must match server `MQTT_TOPIC_ROOT`), OTA command payload (server → device), Quick reference (3 terminals), Related docs, Short checklist (9 steps) (+9 more)

### Community 14 - "Community 14"
Cohesion: 0.10
Nodes (21): compression, cors, dotenv, googleapis, mqtt, dependencies, compression, cors (+13 more)

### Community 15 - "Community 15"
Cohesion: 0.05
Nodes (38): 0. CONTEXT & PROJECT UNDERSTANDING, 1.1 H-1: mTLS Fingerprint Binding at HTTP Edge, 1.2 H-2: Admin JWT Scope Hardening (Interim → Permanent), 1.3 DEV-1: Keep Dev OTA Route — Rename for Pilot v1, 1.4 M-1: Remove WebSocket Server Completely, 1.5 M-2: Trim Health Endpoint Information Disclosure, 1.6 M-3: CORS Origin Restriction, 1.7 M-4: CSR Rate Limiter — Fallback to Local Cache (+30 more)

### Community 17 - "Community 17"
Cohesion: 0.14
Nodes (18): nsToMs(), WebhookLatencyStages, WebhookLatencyTracker, WebhookProvider, tryClaimWebhookDedupe(), ack(), handleGmbWebhook(), parseStarRating() (+10 more)

### Community 18 - "Community 18"
Cohesion: 0.12
Nodes (30): getGmbAccountLookupValues(), DeviceGmbContext, resolveGmbContextForDevice(), createAccessTokenOAuthClient(), getGmbApiAuth(), GmbApiAuth, gmbApiErrorMeta(), locationCacheKeyFromResourceName() (+22 more)

### Community 19 - "Community 19"
Cohesion: 0.19
Nodes (4): IDevice, FirmwareRelease, IFirmwareRelease, OtaService

### Community 20 - "Community 20"
Cohesion: 0.13
Nodes (11): OtaConfig, OtaAdminRoutesDeps, IFirmwareStorage, OtaCommandPublisher, buildOtaDownloadUrl(), buildOtaMqttDownloadUrl(), isLocalLanDownloadUrl(), isOciFirmwareDownloadUrl() (+3 more)

### Community 21 - "Community 21"
Cohesion: 0.31
Nodes (6): DeviceStatus, compareVersions(), isVersionGreater(), mockLogEvent, mockStorage, otaConfig

### Community 22 - "Community 22"
Cohesion: 0.07
Nodes (30): bun-types, ES2020, stimulate/**/*, **/*.test.ts, compilerOptions, allowSyntheticDefaultImports, baseUrl, declaration (+22 more)

### Community 23 - "Community 23"
Cohesion: 0.05
Nodes (36): Close-out Checklist, Completed: P3.1 - Fleet Capacity Documentation, Completed: P3.2 - Prometheus Alerts, Completed: P3.3 - Global Rate Limiting, Completed: P3.4 - Compliance Documentation, Completed: P3.7 - Security Audit Checklist, Current (2026-07-02), Detailed Roadmap (+28 more)

### Community 24 - "Community 24"
Cohesion: 0.13
Nodes (17): ACLRule, ACLRuleSchema, DeviceACL, DeviceACLSchema, DeviceTier, IDeviceACL, GoogleBusinessReviewSchema, IGoogleBusinessReview (+9 more)

### Community 25 - "Community 25"
Cohesion: 0.14
Nodes (14): Attention polling — implementation status, Code references, Dual schedulers — priority and background (both implemented), Intended flow (device scan / NFC), Phase B — Attention / priority signals, Phase C — Fairness, starvation, budgets, Phase D — Observability, Phase E — Topology & dedupe (+6 more)

### Community 26 - "Community 26"
Cohesion: 0.18
Nodes (6): DeviceCertificate, DeviceCertificateSchema, DeviceCertificateSlot, DeviceCertificateStatus, IDeviceCertificate, CAService

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
Cohesion: 0.18
Nodes (9): FirmwareStorageService, metaValue(), OciFirmwareStorageService, isRetryableOciError(), mapOciError(), OciStorageError, OciStorageErrorCode, statusFromMessage() (+1 more)

### Community 31 - "Community 31"
Cohesion: 0.14
Nodes (17): WebhookDeviceTarget, GmbReviewNotification, GmbReviewPayload, mapReviewPayloadToStorage(), ResolveGmbReviewPayloadOptions, GoogleBusinessReview, gmbReviewMetrics(), sha256Payload() (+9 more)

### Community 32 - "Community 32"
Cohesion: 0.12
Nodes (17): Admin API (Bearer user JWT), CI webhook — automated release + per-device push, Device HTTP — `GET /api/v1/ota/download/:version` (proxy mode, optional), Device HTTP — `POST /api/v1/ota/report` (optional fallback), Enable OTA, Finalize validation (server), MQTT — device → server telemetry, MQTT — server → device commands (+9 more)

### Community 33 - "Community 33"
Cohesion: 0.18
Nodes (11): ⚡ 30-Second Setup, Can't connect to MQTT broker?, 📂 Check Your Data, 🔧 Customize, Data not saving?, 📚 Next Steps, Port 3002 in use?, 🚀 Quick Start Guide - MQTT Publisher Lite (+3 more)

### Community 34 - "Community 34"
Cohesion: 0.17
Nodes (12): Admin OTA (interim → planned), Attack surface (production), Change log, Controls verified (positive), Executive summary, POS / integrations webhooks (production today), Production OTA (target state — already implemented except dev route), proofmqtt Security Assessment (+4 more)

### Community 35 - "Community 35"
Cohesion: 0.24
Nodes (4): chunk(), evalAtomicBackoffCheckAndRecordEvalSha(), igPollMetricsInc(), InstagramPoller

### Community 36 - "Community 36"
Cohesion: 0.19
Nodes (21): getClaimBaseUrl(), Campaign, asCampaignForSchedule(), buildCampaignPayload(), campaignSocialIdFilter(), fanoutPromotionToUserDevices(), filterSchedulableCampaigns(), getEligibleCampaignsForUser() (+13 more)

### Community 37 - "Community 37"
Cohesion: 0.06
Nodes (9): httpRequestDuration, httpRequestsTotal, metricsHandler(), metricsMiddleware(), register, HttpServer, DeviceService, SessionService (+1 more)

### Community 38 - "Community 38"
Cohesion: 0.09
Nodes (22): 1.1 Remove Committed Private Keys from Repo, 1.2 Update .env.example with Admin Auth, 1. Immediate (P1 Priority), 2.1 Migrate Runtime to Bun, 2.2 Remove Render Configuration, 2.3 Add ESLint + Prettier, 2. Medium Priority (2-3 days), 3.1 Core Infrastructure (+14 more)

### Community 39 - "Community 39"
Cohesion: 0.11
Nodes (20): app, ensureFreshInstagramAccessToken(), InstagramTokenContext, loadInstagramTokenContextForUser(), correlationIdMiddleware(), HttpConfig, ConnectRefreshCoordinatorDeps, ActiveDevice (+12 more)

### Community 40 - "Community 40"
Cohesion: 0.21
Nodes (9): Device, DeviceOtaState, DeviceSchema, bearerToken(), createRecoveryRoutes(), RecoveryRoutesDeps, eventKey(), buildRecoveryRoutesApp() (+1 more)

### Community 42 - "Community 42"
Cohesion: 0.14
Nodes (14): scripts, build, check, coverage, dev, format, lint, lint:fix (+6 more)

### Community 43 - "Community 43"
Cohesion: 0.18
Nodes (6): createRecoverySessionService(), DeviceRecoveryJwtClaims, hashToken(), RecoverySessionError, RecoverySessionRedisState, RecoverySessionService

### Community 44 - "Community 44"
Cohesion: 0.24
Nodes (17): appClientDir, backupIfExists(), caConfig(), caStoragePath, cmdAppClient(), cmdInitCa(), cmdPrintAppEnv(), cmdRotate() (+9 more)

### Community 45 - "Community 45"
Cohesion: 0.20
Nodes (16): Ad, AdSchema, AdStatus, AdType, IAd, NOTE: This is a READ-ONLY model for mqtt-publisher-lite., buildBrandCanvasPayload(), CachedBrandCanvasDto (+8 more)

### Community 46 - "Community 46"
Cohesion: 0.13
Nodes (14): **1\. Executive Summary & Design Goals**, **2\. Comprehensive Concept Verification Matrix**, **3.1 Dual-Path Trigger Engine**, **3.2 State Tracking Mechanics**, **3\. Core Subsystem Operations**, **4.1 Cooldown and Blacklist Management**, **4.2 Post-Update Safety Architecture**, **4.3 Handshake Reliability (QoS 1 Application Loop)** (+6 more)

### Community 47 - "Community 47"
Cohesion: 0.12
Nodes (22): computeAudience(), main(), loadWebhookConfig(), WebhookConfig, captureRawBody, createWebhookRoutes(), extractBearerToken(), gmbLimiter (+14 more)

### Community 48 - "Community 48"
Cohesion: 0.13
Nodes (14): **1\. Executive Summary & Design Goals**, **2\. Comprehensive Concept Verification Matrix**, **3.1 Dual-Path Trigger Engine**, **3.2 State Tracking Mechanics**, **3\. Core Subsystem Operations**, **4.1 Cooldown and Blacklist Management**, **4.2 Post-Update Safety Architecture**, **4.3 Handshake Reliability (QoS 1 Application Loop)** (+6 more)

### Community 50 - "Community 50"
Cohesion: 0.07
Nodes (46): fetchInstagramProfileMetrics(), InstagramProfileFetchAudit, InstagramProfileFetchError, InstagramProfileFetchResult, InstagramProfileMetrics, sha256Hex(), formatInstagramScreenMqttPayload(), ScreenDeliveryFetchShape (+38 more)

### Community 51 - "Community 51"
Cohesion: 0.17
Nodes (12): Actions required for a **real** OTA release, Cleanup checklist (after device test passes), Direct OCI URL (optional sanity check), Download URL for firmware developer, High-level production path, Original production OTA flow (unchanged), OTA dev download test (temporary), Production download modes (+4 more)

### Community 52 - "Community 52"
Cohesion: 0.18
Nodes (11): DailyMetricsRedisKeys, DateBucketResult, getDailyMetricsKeys(), getDateBucket(), getStartOfDayInTimezone(), getTimezoneOffsetMs(), priceToCents(), resolveMetricsTimezone() (+3 more)

### Community 53 - "Community 53"
Cohesion: 0.08
Nodes (23): extends, ignorePatterns, dist/, node_modules/, parser, parserOptions, project, plugins (+15 more)

### Community 54 - "Community 54"
Cohesion: 0.19
Nodes (17): createOtaAdminRoutes(), requireAdminAuth(), OtaReleaseWebhookDeps, AuditEntry, AuditEventType, AuditLogData, AuditServiceConfig, createAuditService() (+9 more)

### Community 55 - "Community 55"
Cohesion: 0.16
Nodes (10): createInfluxService(), GmbReviewSnapshotInfluxInput, GmbVelocityWeeklyInfluxInput, GmbWebhookAuditInfluxInput, SocialMetrics, WebhookDeviceResolutionInfluxInput, WebhookMqttDeliveryInfluxInput, WebhookPlatform (+2 more)

### Community 56 - "Community 56"
Cohesion: 0.13
Nodes (8): InstagramCircuitEventInfluxInput, InstagramFetchAuditInfluxInput, InstagramMilestoneCrossedInfluxInput, InstagramMqttDeliveryInfluxInput, MilestoneCrossedInfluxInput, ProfileBaselineInfluxInput, VelocityWeeklyInfluxInput, InstagramAuditRepo

### Community 57 - "Community 57"
Cohesion: 0.19
Nodes (16): CampaignSchema, CampaignStatus, DiscountType, ICampaign, ScheduleType, TargetType, Provider, isCampaignActive() (+8 more)

### Community 58 - "Community 58"
Cohesion: 0.22
Nodes (15): main(), setMqttTlsClientPem(), applyMqttJsTlsOptions(), buildMqttTlsPrecheckOptions(), buildNodeTlsConnectOptions(), MqttTlsConnectMaterial, netIsIp(), normalizeTlsPem() (+7 more)

### Community 59 - "Community 59"
Cohesion: 0.26
Nodes (6): BaseInfluxRepo, OtaReleaseEntryInput, TransparencyEntryInput, PkiAuditInput, PkiAuditRepo, BucketTarget

### Community 60 - "Community 60"
Cohesion: 0.33
Nodes (5): engines, bun, name, type, version

### Community 61 - "Community 61"
Cohesion: 0.22
Nodes (9): 🏗️ Architecture, 📊 Comparison with Full Version, 📚 Documentation, ✨ Features, 📄 License, 🚀 MQTT Publisher Lite, 🚂 Railway Deployment, 🤝 Support (+1 more)

### Community 62 - "Community 62"
Cohesion: 0.23
Nodes (14): extractMtlsIdentityFromNativeTls(), extractMtlsIdentityFromProxy(), findActiveCertForSlots(), firstHeader(), MtlsCertSlot, MtlsIdentity, normalizeFingerprint(), normalizeForwardedPem() (+6 more)

### Community 64 - "Community 64"
Cohesion: 0.24
Nodes (5): main(), OCI_PYTHON_SDK_CONNECTION_TIMEOUT, OCI_PYTHON_SDK_READ_TIMEOUT, instance.sh script, write_metadata()

### Community 65 - "Community 65"
Cohesion: 0.14
Nodes (7): InstagramServerlessConfig, fetchInstagramMetrics(), InstagramDirectFetchInvoker, InstagramFetchInvoker, InstagramServerlessBridge, sleep(), toNormalizedRow()

### Community 66 - "Community 66"
Cohesion: 0.22
Nodes (9): App runtime & metrics, 🔧 Configuration, Core (MQTT & HTTP), Feature flags (all default `true`), Integrations, Legacy environment names (deprecated), MongoDB connection pool, MQTT TLS / mTLS (production) (+1 more)

### Community 67 - "Community 67"
Cohesion: 0.22
Nodes (12): csrRateLimiter(), DEFAULT_CONFIG, incrementCounter(), incrementLocalCounter(), localCounters, RateLimitConfig, rejectRateLimited(), createProvisioningRoutes() (+4 more)

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
Nodes (12): deprecatedWarned, envBool(), envInt(), envString(), resolveMqttClientId(), warnDeprecatedEnv(), loadConfig(), loadOciCredentialsFromEnv() (+4 more)

### Community 74 - "Community 74"
Cohesion: 0.25
Nodes (4): HTTPServer, Handler, ReuseHTTPServer, SimpleHTTPRequestHandler

### Community 75 - "Community 75"
Cohesion: 0.27
Nodes (9): main(), parseArgs(), sha256Hex(), OtaOciConfig, createFirmwareStorageService(), createOciAuthProvider(), hasOciEnvCredentials(), normalizePemFromEnv() (+1 more)

### Community 76 - "Community 76"
Cohesion: 0.23
Nodes (11): ActiveSetRedisClient, devicesNeedingHydration(), HydrateActiveDeviceFn, republishCachedScreensForActiveDevices(), republishGmbFromCache(), republishInstagramFromFollowersCache(), restoreActiveDevicesFromRedis(), hasStimLock() (+3 more)

### Community 77 - "Community 77"
Cohesion: 0.14
Nodes (13): abandonAttentionCorrelation(), applyInstagramServerlessDeviceOutcome(), evalAtomicBackoffCheckAndRecord(), getCircuitBreaker, getCrossedMilestones(), maybeApplyGlobalCircuit(), maybeOpenCircuitFromOutcome(), normalizeResponseBody() (+5 more)

### Community 79 - "Community 79"
Cohesion: 0.40
Nodes (4): Cloud / local config, Removal Checklist (after testing), Reset after a completed ramp, stimulate/ — TEMP Testing-Phase (in-process)

### Community 80 - "Community 80"
Cohesion: 0.29
Nodes (7): 📡 API Endpoints, Create Session, Create User, Get All Devices, Health Check, Publish MQTT Message, Register Device

### Community 81 - "Community 81"
Cohesion: 0.31
Nodes (7): resolveConnectionsValidateApiKey(), ConnectionsRoutesDeps, createConnectionsRoutes(), PROVIDER_MAP, VALID_EVENTS, ConnectionValidateEvent, app()

### Community 82 - "Community 82"
Cohesion: 0.18
Nodes (12): FirmwareReleaseSchema, FirmwareReleaseStatus, FirmwareRolloutSchema, FirmwareRolloutStrategy, IFirmwareRollout, createOtaRoutes(), OtaRoutesDeps, checkOtaRateLimit() (+4 more)

### Community 84 - "Community 84"
Cohesion: 0.33
Nodes (5): Health, Production setup, Scope, Shadow mode, Webhook → MQTT (GMB MVP)

### Community 85 - "Community 85"
Cohesion: 0.17
Nodes (11): ACLCacheEntry, ACLRule, ACLStats, ACLValidationResult, CertificateInfo, DeviceACL, DeviceConnectionInfo, DeviceTier (+3 more)

### Community 86 - "Community 86"
Cohesion: 0.47
Nodes (5): DeviceCertSlot, DeviceCertStatus, isUniqueDeviceIdIndex(), main(), requireEnv()

### Community 87 - "Community 87"
Cohesion: 0.31
Nodes (8): createLifecycleRoutes(), httpStatusForRecoveryError(), LifecycleDeps, postRecoveryWebhook(), reissueLimiter, decodeCsrToPem(), buildLifecycleRoutesApp(), mockFindOne

### Community 88 - "Community 88"
Cohesion: 0.20
Nodes (9): jest, tests/**/*.ts, compilerOptions, noEmit, types, extends, include, node (+1 more)

### Community 89 - "Community 89"
Cohesion: 0.20
Nodes (10): DEV-1: Unauthenticated dev OTA download (accepted temporary), Findings, H-1: mTLS identity from proxy header without fingerprint binding, H-2: OTA admin — any valid user JWT (interim), L-1: Static firmware testing UI, L-2: `/health` device enumeration (aggregate only), M-1: WebSocket `/ws` mirrors all MQTT traffic, M-2: Operational information disclosure (+2 more)

### Community 91 - "Community 91"
Cohesion: 0.50
Nodes (5): extractBearerToken(), getGmbPubsubAudience(), verifyPubSubPushRequest(), GmbPubsubVerifyConfig, PubSubPushVerificationResult

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
Cohesion: 0.25
Nodes (5): CAConfig, DeviceAlreadyHasCertificateError, NOTE: Some deployments may still have a legacy UNIQUE index on { device_id } (no, RootCA, UnsupportedCSRKeyTypeError

### Community 99 - "Community 99"
Cohesion: 0.32
Nodes (3): DeviceMetrics, SystemMetrics, DeviceMetricsRepo

### Community 100 - "Community 100"
Cohesion: 0.83
Nodes (3): cleanup_stale_jest(), on_interrupt(), run-unit-tests.sh script

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
Cohesion: 0.33
Nodes (7): express, express, getSwaggerSpec(), resetSwaggerSpecCache(), resolveApiGlobs(), setupSwaggerUi(), swaggerDefinition

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
Cohesion: 0.33
Nodes (6): 1. Added `isRedisConfigured()` Method, 2. Added Configuration Check in `connect()` Method, 3. Added Configuration Check in `app.ts`, 4. Fixed `disconnect()` Error Handling, 5. Updated Config Validation, ✅ Solution

### Community 113 - "Community 113"
Cohesion: 0.33
Nodes (6): HTTP server, MQTT push, OTA download / verify, Serial port / flash, Troubleshooting, WiFi

### Community 114 - "Community 114"
Cohesion: 0.33
Nodes (5): MQTT_BROKER, MQTT_PORT, MQTT_TLS_REJECT_UNAUTHORIZED, OTA_FIRMWARE_VERSION, run-e2e.sh script

### Community 115 - "Community 115"
Cohesion: 0.67
Nodes (4): AppConfig, ConfigRoutesDeps, createConfigRoutes(), buildConfigRoutesApp()

### Community 116 - "Community 116"
Cohesion: 0.43
Nodes (5): buildOtaProxyDownloadUrl(), OtaDownloadMode, otaOciParBaseUrl(), resolveOtaDownloadMode(), resolveOtaPublicBaseUrl()

### Community 119 - "Community 119"
Cohesion: 0.33
Nodes (5): DeviceInfo, MqttMessage, PublishOptions, SessionInfo, UserInfo

### Community 122 - "Community 122"
Cohesion: 0.40
Nodes (4): sha256, signature, size_bytes, version

### Community 123 - "Community 123"
Cohesion: 0.60
Nodes (3): verify-broker-tls.sh script, usage(), verify_one()

### Community 125 - "Community 125"
Cohesion: 0.08
Nodes (20): main(), mongodbSrvHostname(), sanitizeUri(), validateUriShape(), mongoDriverTimeouts(), IUser, NOTE: This is a READ-ONLY model for mqtt-publisher-lite., User (+12 more)

### Community 126 - "Community 126"
Cohesion: 0.40
Nodes (4): express-serve-static-core, http, IncomingMessage, Request

### Community 128 - "Community 128"
Cohesion: 0.50
Nodes (4): Device firmware config (mqttclient), Hardware & host, Prerequisites, Repos & tools

### Community 129 - "Community 129"
Cohesion: 0.50
Nodes (4): Production commands, Production OCI flow (server + Oracle Object Storage), Production verification checklist, Server prerequisites

### Community 130 - "Community 130"
Cohesion: 0.50
Nodes (3): Layout, Notes, PKI scripts

### Community 131 - "Community 131"
Cohesion: 0.33
Nodes (5): ✅ Already Implemented, Key Files to Examine, Next Steps, ❌ Not Implemented, Summary

### Community 132 - "Community 132"
Cohesion: 0.33
Nodes (5): Bun Runtime Security Notes, Known Risks, Mitigations, Monitoring, Version Policy

### Community 134 - "Community 134"
Cohesion: 0.40
Nodes (4): Based on current codebase post-Phase 2 - NOT a pentest snapshot, Last Updated: 2026-07-02 (Phase 2 completion), Previous Pentest Date: 2026-06-23, Security Audit Checklist

### Community 136 - "Community 136"
Cohesion: 0.22
Nodes (8): exclude, extends, include, dist, node_modules, src/**/*, tests/**/*, ./tsconfig.json

### Community 139 - "Community 139"
Cohesion: 0.67
Nodes (3): Certificate revocation (NanoMQ), Pilot v1 hardening, 🔐 Security & limitations (V5.0)

## Knowledge Gaps
- **751 isolated node(s):** `root`, `parser`, `@typescript-eslint`, `eslint:recommended`, `plugin:@typescript-eslint/recommended` (+746 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **62 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `InfluxService` connect `Community 1` to `Community 99`, `Community 69`, `Community 101`, `Community 133`, `Community 135`, `Community 12`, `Community 17`, `Community 54`, `Community 55`, `Community 56`, `Community 59`?**
  _High betweenness centrality (0.076) - this node is a cross-community bridge._
- **Why does `logger` connect `Community 39` to `Community 0`, `Community 2`, `Community 3`, `Community 4`, `Community 6`, `Community 8`, `Community 12`, `Community 17`, `Community 18`, `Community 30`, `Community 31`, `Community 36`, `Community 40`, `Community 43`, `Community 45`, `Community 47`, `Community 50`, `Community 52`, `Community 54`, `Community 55`, `Community 59`, `Community 62`, `Community 67`, `Community 69`, `Community 73`, `Community 76`, `Community 81`, `Community 82`, `Community 87`, `Community 98`, `Community 125`?**
  _High betweenness centrality (0.045) - this node is a cross-community bridge._
- **Why does `MqttClientManager` connect `Community 41` to `Community 65`, `Community 2`, `Community 68`, `Community 37`, `Community 6`, `Community 39`, `Community 4`, `Community 9`, `supertest`, `Community 12`, `Community 76`, `Community 47`, `Community 50`, `Community 20`, `Community 54`, `Community 31`?**
  _High betweenness centrality (0.044) - this node is a cross-community bridge._
- **What connects `root`, `parser`, `@typescript-eslint` to the rest of the system?**
  _751 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.12923076923076923 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.061170212765957445 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.05807622504537205 - nodes in this community are weakly interconnected._