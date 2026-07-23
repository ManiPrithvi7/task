PROOFMQTT SERVER CODEBASE â UNCENSORED REPORT
1. ARCHITECTURE
App.ts is a 2227-line god object. It does everything: MQTT lifecycle, HTTP server setup, device registration, OTA delivery, Instagram polling, stats publishing, TLS pre-checks, ENV-based certificate generation, keep-alive, and shutdown orchestration. This is a severe Single Responsibility Principle violation.
The pattern is: one class (MqttPublisherLite) with ~30+ methods, registering routes imperatively inside initializeHttpServer() instead of having a proper DI framework. Services are instantiated ad-hoc via new or factory functions scattered across the file.
Strengths: The layered structure (config â services â routes â models â storage) is present in spirit, and the graph shows no import cycles.
Reality: Coupling is high. StatsMqttLite (the god class) has 75 edges â the most connected node in the entire graph. logger is injected everywhere with 72 edges. InfluxDB service has 67 edges. These are cross-cutting concerns that should be abstracted behind interfaces, not directly depended on by everything.
2. SECURITY â THE GOOD, THE BAD, THE UGLY
Good:
- mTLS fingerprint binding (mtlsAuth.ts): properly extracts client cert from proxy headers, normalizes PEM, compares SHA-256 fingerprints. Rejects on mismatch.
- Certificate lifecycle management: staging/primary slots, renewal flow, recovery session tokens, chain validation, KU/EKU enforcement (all optional via config).
- Hash-chained audit log with SHA-256 and sequence counters, InfluxDB-backed.
- Rate limiting on CSR endpoints.
- CSR validation: enforces RSA 2048-bit minimum, device ID in CN/SAN.
Bad:
- Default JWT secret: 'mqtt-publisher-lite-secret-key-change-in-production' â hardcoded in src/config/index.ts:215. If JWT_SECRET and PROVISIONING_JWT_SECRET are both unset, this fallback is used. One exposed .env or dev deployment and your PKI is compromised.
- Default requireMtlsForRegistration = true means if MongoDB is down or caService is null, the check short-circuits to return true (line ~1278 in app.ts). Network partition = no mTLS enforcement.
- reissue route (lifecycleRoutes.ts): no mTLS requirement. Takes a recovery_token + device_id + CSR. If the recovery session system is compromised, an attacker can revoke all device certs and issue a new one in one call (caService.revokeAllDeviceCertificates(deviceId) followed by signCSR(...)).
- Admin OTA auth: checks email domain (ADMIN_EMAIL_DOMAINS) or explicit userId list. This is a comma-separated env var â weak compared to proper IAM.
- X-Forwarded-Proto trust: in provisioningRoutes.ts line ~1155, the download URL uses req.get('x-forwarded-proto') ?? 'http'. If your reverse proxy doesn't strip this header, an attacker can forge it.
Ugly:
- findActiveCertForSlots in mtlsAuth.ts: catches all errors with generic null return. If the DB query throws for any reason (connection blip, timeout, schema change), the middleware silently skips the fingerprint check and passes the request. This means a DB failure effectively disables mTLS auth.
- No CRL/OCSP: certificate revocation is soft (status field in MongoDB). No distribution point, no revocation checking at runtime. Even if you revoke, connected clients won't know until they re-auth.
3. OTA SUBSYSTEM â OVERENGINEERED AND FRAGILE
The OTA system (otaService.ts, 1843 lines) handles:
- Release ingestion (CI webhook + manual)
- Staged rollouts (percentage tiers with failure detection)
- Staging slot promotion with abort logic
- Authentication failure thresholds, cooldowns, blacklists
- MQTT push with QoS 1 delivery tracking
- Multiple download modes (proxy, presigned PAR, MQTT)
- Slack alerts
- Release log (InfluxDB CT-like append-only)
Real problems:
- Release webhook security: POST /api/webhooks/ota-release is protected by a single bearer secret (OTA_RELEASE_WEBHOOK_SECRET). If that leaks, anyone can push firmware.
- TEST_OTA mode (env var TEST_OTA=true): bypasses ALL version gates, eligibility, rollout percentages. Pushes proof:1.0.1 to every device that connects. Documented as "temporary" but still present in production code. One misconfiguration and you OTA-brick your fleet.
- deliverPendingToDevice is called on EVERY device registration. If you have 10K devices reconnecting after a network outage, the server fans out 10K OTA checks simultaneously.
- maybeRecordImplicitOtaSuccess: infers OTA success from a device booting a newer version. No cryptographic proof, no attestation.
4. DATABASE CHOICES â JACK OF ALL TRADES, MASTER OF NONE
Store	Purpose	Risk
MongoDB	Primary data (devices, users, certs, firmware releases)	Single point of truth for everything. No read replicas configured.
Redis	Active device cache, Instagram polling queues, rate limiter counters, provisioning tokens	Falls back silently to in-memory if REDIS_URL is unset. Memory leak possible on large fleets.
InfluxDB	Time-series metrics, audit log, compliance	Required at startup. Without it, the server won't start â validateConfig throws if INFLUXDB_TOKEN is missing. InfluxDB is treated as a hard dependency despite being a TSDB.
InfluxDB Disk Queue	WAL for InfluxDB writes	File-based queue with fsync option. If the file grows unbounded (default 100K lines per file) and the flush worker dies, you lose data.
SQLite (historically)	Certificate store	Replaced by MongoDB, but the _dbPath parameter is still present in CAService constructor for "backward compatibility."
The hard InfluxDB dependency is architectural debt. A TSDB should not be a hard startup requirement for a server that primarily routes MQTT messages. If InfluxDB is down, the whole server refuses to start â even if the device registration and messaging features would work fine.
5. CONFIGURATION â ENV VARIABLE HELL
src/config/index.ts (1030 lines) reads from ~80+ environment variables, some of which have 2-3 legacy aliases (MQTT_TLS_CA_PEM / MQTT_TLS_CA_CERT / MQTT_TLS_CA_BASE64; OTA_ED25519_PUBLIC_KEY_PEM / OTA_ED25519_PUBLIC_KEY_BASE64 / OTA_ED25519_PUBLIC_KEY_PATH).
The config file:
- Writes files to disk during loadConfig() (writeProvisioningRootCaFromEnv)
- Has commented-out production checks (Redis URL requirement for production is commented out)
- Contains literal JWT token examples in comments (lines ~1017-1030)
- Has nested InstagramPollingConfig with 17+ tuning parameters (priority intervals, backoff, budgets, caps, zset max members, fair rotation) â most of which are 0 (disabled) by default
This is configuration by exhaustion. The Instagram polling alone has more tuning knobs than most production databases.
6. TESTING â ANEMIC
tests/
âââ unit/
â   âââ routes/
â   â   âââ configRoutes.test.ts
â   â   âââ provisioningRoutes.test.ts
â   âââ services/
â   â   âââ otaService.test.ts
â   â   âââ promotionService.test.ts
â   â   âââ otaReleaseLog.test.ts
â   âââ utils/
âââ integration/
â   âââ recovery/
For a codebase with:
- ~144K words across 276 files
- 2227-line app.ts
- 1843-line otaService.ts
- 1030-line config/index.ts
- 380+ line caService.ts
- 780+ line provisioningRoutes.ts
- Multiple storage layers, auth middleware, rate limiters, PKI, OTA state machines
You have maybe 5-6 meaningful test files. The most critical code (app.ts, mtlsAuth.ts, caService.ts, provisioning routes, lifecycle routes, influx service) has ZERO unit tests. The mTLS fingerprint binding â the most security-critical middleware â has no test coverage. The CSR signing flow has no tests. The staged rollout logic's abort decisions have no coverage.
This is a codebase that's been built for months without a testing budget.
7. DIRECTORY STRUCTURE MADNESS
src/
âââ app.ts                  â 2227 lines, god class
âââ config/
â   âââ index.ts            â 1030 lines, env parsing + file I/O
âââ middleware/              â 5 files (clean)
âââ models/                  â 14 models (too many for the value)
âââ routes/                  â 11 route files (reasonable)
âââ services/                â 35 files! This is where everything lives
â   âââ googleBusiness/      â subdirectory for one integration
â   âââ metrics/             â subdirectory
â   âââ ...
âââ servers/
â   âââ mqttClient.ts        â MQTT client wrapper
âââ storage/
â   âââ influx/
â       âââ repositories/    â 11+ repo files for Influx queries
â       âââ types.ts
âââ utils/                   â 18 utility files
âââ webhooks/                â webhook handling
â   âââ resolve/             â subdirectory
âââ notifications/           â Slack alerts
35 services is absurd for a project this size. Many are anemic wrappers (1-2 methods) that could be consolidated. The proliferation is driven by the lack of DI â each "service" is a class that needs to be manually instantiated and wired in app.ts.
8. INSTAGRAM POLLING â UNSOLICITED FEATURE
The Instagram polling subsystem is a full dual-scheduler with Redis Lua scripts, priority queues, background workers, serverless bridges, fairness rotation, budgets, backoff, deduplication, and milestone detection. It accounts for roughly 20-25% of the codebase.
This is in a MQTT + provisioning server. Unless you're selling Instagram analytics as a product, this is scope creep of the highest order. The stimulate/ directory (temporary testing-phase code per its own comments) should have been deleted, not committed.
9. VERDICT
Dimension	Grade	Why
Security fundamentals	B	mTLS binding is solid. But default secrets, silent mTLS bypass on DB failure, and weak admin auth are real liabilities.
Architecture	D	2227-line god class, 35 services, no DI, imperative wiring in app.ts. Will be painful to maintain or extend.
Testing	F	~5 tests for 276 files. Zero tests for the most security-critical code.
Config complexity	D	80+ env vars with legacy aliases. Config file does disk I/O and is 1030 lines.
OTA design	B-	Feature-rich but overengineered. TEST_OTA mode is a footgun. Release webhook relies on single shared secret.
Feature focus	F	Instagram polling is a massive distraction in a provisioning + MQTT server. Scope creep is out of control.
Code quality	C	The graph says no import cycles, which is good. But method sizes, file sizes, and coupling are problematic.
Bottom line: The PKI/mTLS layer is actually well-designed. The OTA system is ambitious and has good safety mechanics (staged rollout, failure detection, rollback). But the server as a whole suffers from severe mission creep, inadequate testing, and a god-class architecture that will become unmanageable at scale. The Instagram polling subsystem alone could be extracted into its own microservice, yet it's tightly coupled into the main MQTT server's lifecycle. The 1030-line config file that writes files and decodes base64 PEMs at import time is a maintenance hazard. And the absence of tests for the most security-critical paths (mTLS middleware, CSR signing, provisioning routes) means you're flying blind on your most important features.