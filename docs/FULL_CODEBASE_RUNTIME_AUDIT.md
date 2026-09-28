# Full Codebase Runtime Audit

Audit date: 2026-09-28  
Scope: production entry point, `src/`, `stimulate/`, package/build/deployment configuration, and runtime-relevant scripts  
Method: static import/build graph, startup/shutdown tracing, targeted lifecycle searches, and TypeScript unused-symbol diagnostics  
Mutation policy: investigation was read-only. Arm 0 instrumentation/hygiene now exists in the working tree (not yet deployed).

## Confidence and scope limits

- **Confirmed** means a path is directly visible in the production entry graph or a lack of references was checked across source, tests, scripts, documentation, and the Bun production bundle.
- **Likely** means the static evidence is strong, but deployment environment values or traffic patterns determine whether the path is active.
- **Uncertain** means runtime configuration, external callers, or dynamic file discovery must be verified before cleanup.
- Static sections use local source defaults unless marked conditional. The later production-investigation section records selected non-secret Railway values and deployed-runtime evidence separately.
- The Bun production build includes 165 modules from `src/index.ts`. Type-only files disappear from the emitted bundle and are not dead solely for that reason.
- This is a static audit. It identifies mechanisms and exact configured rates; it does not invent observed CPU, memory, or query-volume measurements.

## Production Investigation — 2026-09-28

This section records read-only evidence from Railway project `awake-enchantment`, production service `task`.

### Deployment and configuration

- Production has **one replica** in `europe-west4-drams3a`.
- Deployed commit: `cf4dab1366ff267b6481e581928c70885c2e30f4`.
- Audited local HEAD: `33a9ecb7c9d07cfd744a399670aa01573f5e9c52`. Production is therefore not running the exact local revision.
- The exact cleanup-path diff (`config/index.ts`, `app.ts`, `deviceService.ts`) contains no cleanup semantic change. The only `app.ts` difference is unrelated certificate-profile wiring.
- The principal memory/diagnostic paths (`index.ts`, `leakHunter.ts`, `metrics.ts`, Redis/Influx services and queues) are unchanged between deployed SHA and HEAD.
- `DEVICE_CLEANUP_INTERVAL` is unset.
- `REDIS_USAGE_CSV_ENABLED` is unset in production. HEAD now treats the CSV as **opt-in** (`true`/`1` only); deploying Arm 0 without the flag stops Redis CSV writes.
- Redis URL, Influx URL, and Influx token are configured (values were not printed).
- Influx queue override variables are unset.
- `DATA_DIR` is unset, resolving to `/app/data`.
- Production sets legacy `BATCH_TIMEOUT=5000`, which `influxConfig.ts` accepts as the fallback for `INFLUXDB_QUEUE_FLUSH_MS`. There was no 5000→1000 code change between deployed SHA and HEAD; the 5-second production behavior comes from this environment override.
- No Railway persistent volume is attached to `task`; files under `/app/data` are deployment-local/ephemeral, though they can still consume the container filesystem until restart.

### Cleanup interval correction

The original audit incorrectly classified the cleanup interval as a seconds/milliseconds bug. Direct inspection confirms:

- `src/config/index.ts` supplies `3600` seconds.
- `DeviceService` accepts seconds and multiplies by `1000` in its constructor (`src/services/deviceService.ts:180-186`).
- Production startup logs explicitly report `cleanupInterval: "3600s"`.

The default cleanup executes once per hour, not every 3.6 seconds.

This closes the cleanup-unit finding for both deployed SHA and current HEAD. The original static audit missed the constructor conversion; other runtime-impact citations should therefore be treated as candidates until reconciled against the deployed SHA or runtime evidence.

### Characterization verdict

The leak is characterized well enough to stop auditing and start intervening:

- Boot floor **602.08 MB RSS** (first stabilized sample 2026-09-24 09:05 UTC).
- Slopes **9.83 / 9.90 / 9.84 MB/h** across boot→series, the 499-minute series, and the full 93-hour lifetime — linear since boot, no acceleration, no plateaus.
- One replica, near-idle traffic.
- Event-driven JavaScript maps are a distant-last explanation on **workload and linearity**. `recentPublishes` is the one timer-shaped exception and is excluded on **arithmetic** (~0.6 MB/h at 60s/10 KB) pending the Arm 0 size gauge. Keep gauges; they are cheap and harden the eventual Bun issue report.
- `heapUsed` is untrustworthy on Bun 1.3.12 until a 1.4.x arm repairs the instrument.
- Two file-I/O churn sources have per-op arithmetic that fits a constant ~10 MB/h at zero traffic.
- A runtime line (1.4.2) both repairs `heapUsed` and may fix the leak. Arm 0 code is in HEAD; the next event is the deploy that pins `INFLUXDB_QUEUE_FLUSH_MS=5000`.

A platform SIGTERM at 2026-09-28 06:31:20 UTC reset RSS from ~1.52 GB to ~606 MB. That process is the new live baseline; do not mix pre/post-restart samples. The floor replicated at 602.08 MB (2026-09-24 boot) and ~606 MB (2026-09-28 boot) on the same SHA — **deterministic to about ±5 MB**, so arm-to-arm floor comparisons are meaningful.

### Mongo query and memory slope

The latest 500 `memory_usage` samples cover 499 minutes:

| Metric | First | Last | Change |
|---|---:|---:|---:|
| `databaseQueries` | 444 | 453 | +9 |
| RSS | 1435.58 MB | 1517.95 MB | +82.37 MB |
| heap used | 146.73 MB | 145.39 MB | -1.34 MB |
| heap total | 133.07 MB | 132.55 MB | -0.52 MB |
| external | 36.05 MB | 35.76 MB | -0.29 MB |
| array buffers | 25.18 MB | 24.95 MB | -0.23 MB |

- Mongo slope: **0.018 commands/minute**, or approximately **1.08/hour**.
- All nine counter increments occurred exactly 60 minutes apart.
- This strongly matches the hourly `Device.deleteMany` cleanup command.
- It does **not** support a 3.6-second cleanup loop or health-query slope.
- The characterized process (pre-06:31 restart) started on 2026-09-24 at 09:04 UTC. Its first stabilized sample was **602.08 MB RSS** at 09:05.
- The 499-minute series began 84.77 hours after that process start at 1435.58 MB and ended at process age 93.08 hours at 1517.95 MB. The live replica is the 06:31 restart (~606 MB floor); do not mix the two.
- RSS slopes are strikingly consistent: **9.83 MB/hour** from boot floor to series start, **9.90 MB/hour** during the series, and **9.84 MB/hour** across the full 93-hour lifetime. The growth is cumulative and approximately linear since boot.
- The deployed logger does **not** call `Bun.gc(true)` and does not emit pre/post-GC RSS. Therefore this series does not prove retained native memory. Garbage may be collected while JSC/mimalloc retains committed pages.
- Bun 1.3.12's `heapUsed` is untrustworthy. The samples report `heapUsed > heapTotal`, matching Bun's confirmed [`process.memoryUsage()` reporting defect](https://github.com/oven-sh/bun/pull/39593): it reports the last eden-collection value rather than the latest full collection. The fix was merged after Bun 1.4.0 and is not in 1.3.12 or 1.3.14. Distrusting the gauge is the conservative call; it is **not** the argument that excludes the Maps/Sets.
- The eight JS growth candidates: **seven are event-driven** (backoff/dedupe per unique device ID, `perIp` per socket connection, chains per observed device, delivered sets per release, deferred queues per device storm). The idle window showed no such inflow: Instagram fetches 0, HTTP request counter flat across the 499-minute series, loyalty dormant, OTA silent. Linearity excludes those seven.
- **`recentPublishes` is the exception.** It grows on every successful `publish()`, and cleanup runs only inside the inbound `message` listener. A cadence publisher would make this map look linear. There is no application `setInterval` that calls `mqtt.publish`; Instagram/OTA/GMB/loyalty publishes are event/fetch driven. Production stimulate ticks exist but currently skip (`Device not active`). Entries store a topic + 100-char payload prefix and metadata — not a full payload copy. At a hypothetical 60s publish cadence and a generous 10 KB/entry, that is ~0.6 MB/h (~6% of the slope). To be the whole leak each entry would need ~170 KB. Arm 0 makes `recentPublishes.size` the **priority gauge** and restores the `publishes`/`mqttMessages` increments (they were commented out during v1/v5 connect-path inspection, not because incrementing was unsafe).
- MQTT `mqttMessages`/`publishes` zeros on the characterized replica were never proof (increments were off). They are also unnecessary for the other seven maps.
- The **shape** of the slope is the stronger exclusion for event-driven maps. 9.83 / 9.90 / 9.84 MB/h across three independent windows is linear since boot. Event-driven retention produces steps. A constant ~10 MB/h at near-zero traffic is the signature of per-tick accumulation in repeating machinery.
- Minor corroboration only: series `heapUsed` endpoints 146.73 → 145.39 MB are distinct GC snapshots 8.3 hours apart showing a slight decline. Weak evidence against live-set growth even under the buggy metric; do not rest the case on it.
- Flat `external` and `arrayBuffers` still argue against JS-visible Buffer/ArrayBuffer retention. Keep aggregate Map/Set/cache gauges — they are cheap, confirm the workload argument, and belong in a later Bun issue report. Do not treat them as a prerequisite for ranking JS last.

### Runtime and log churn

- Production is pinned to **Bun 1.3.12** by both Docker stages.
- Latest 1.3.x is **1.3.14**; latest overall release observed is 1.4.2.
- No release-note entry in 1.3.13 or 1.3.14 specifically claims an RSS/allocator fix.
- Bun 1.4.2 contains merge commit `91cdf159` from [`process.memoryUsage()` fix #39593](https://github.com/oven-sh/bun/pull/39593), so it both tests a newer runtime and repairs the `heapUsed` instrument.
- Bun has open memory-growth reports, including high-volume `fetch` retention through at least 1.3.9 ([#20912](https://github.com/oven-sh/bun/issues/20912)). Production's sampled Instagram fetch counters were zero, so that exact high-fetch case does not explain this near-idle interval.
- Over a 5.99-hour sample, Railway recorded 442 application log lines: **73.8 lines/hour**.
- Breakdown: 360 `memory_usage` lines (60/hour), 72 `leak_hunter_sample` lines (12/hour), and 10 other lines.
- Keep the minute `memory_usage` logger during experiments; it is the current longitudinal instrument.
- Leak hunter writes files every 30 seconds even though it emits a summary log every five minutes. Reducing/disabling it should be an isolated experiment arm.

### Influx and disk evidence

Production logs confirm:

- Metrics WAL: `/app/data/influx-write-queue.lines.metrics`
- Compliance WAL: `/app/data/influx-write-queue.lines.compliance`
- Deployed flush interval: **5,000 ms per queue**, from Railway `BATCH_TIMEOUT=5000`. The code fallback default has been `1000` since commit `5f4d4a7` (2026-07-24, Maniprithvi7, environment-validation work). README still documents `INFLUXDB_QUEUE_FLUSH_MS` as `5000`; `.env.example` comments `1000`. This is months-old docs/code drift, not a change between deployed SHA and HEAD, and production never used the code fallback.
- **Who changed 5000→1000, and why?** The code default is 1000 in both SHAs. If a 1-second flush is a deliberate durability/latency choice, it deserves its **own soak arm**, not a silent ride-along into the baseline. Arm 0 therefore pins `INFLUXDB_QUEUE_FLUSH_MS=5000` so deploying HEAD cannot 5× the #2 suspect's tick rate if `BATCH_TIMEOUT` is ever unset.
- Batch maximum: 500.
- Metrics queue `syncOnAppend=false`; compliance queue `syncOnAppend=true`.
- Several brief `ECONNREFUSED` flush failures restored 2–4 unsent lines on 2026-09-22.
- Leak diagnostics write `/app/data/leak-hunter.jsonl` and `/app/data/leak-hunter-latest.json`.
- No Redis CSV write failures were found in the sampled deployment logs.

Exact file sizes and modification times could not be collected: Railway SSH access is blocked because the account has no registered SSH key. Registering a key would modify account configuration and was not performed. Because no persistent volume is attached, the Railway volume file API cannot inspect `/app/data`.

The same SSH blocker prevents collecting `/proc/1/smaps_rollup`. Both the disk metadata snapshot and smaps snapshot should be taken twice, approximately 12 hours apart, once access is registered.

Arm 0 should remove this access dependency by self-reporting selected `/proc/self/smaps_rollup` and `/proc/self/status` fields plus file sizes/mtimes in the existing minute diagnostic. Do not log complete proc files or file contents.

### Baseline reset observed

At 2026-09-28 06:31:20 UTC, the existing deployment received SIGTERM, shut down gracefully, and restarted without a new deployment. The latest successful Railway deploy remains `f92c2444` from 2026-09-21; this was a process restart of that same deployment. 1.52 GB is nowhere near the 8 GB limit, and limit kills are SIGKILL, not graceful SIGTERM — this was not an OOM/memory-limit kill. Most likely a manual `railway restart` or host maintenance. A health-check-failure restart is not evidenced in application logs (no unhealthy/health-fail line adjacent to the SIGTERM). Treat 06:31 UTC as a new baseline boundary; do not combine pre- and post-restart samples into one slope.

The boot floor replicated: **602.08 MB** (2026-09-24) and **~606 MB** (2026-09-28) on the same SHA — deterministic to about ±5 MB.

## Executive Summary

The service is not a lightweight MQTT publisher at runtime. One Bun process owns HTTP, MongoDB, Redis, MQTT, InfluxDB, two Instagram schedulers, device/session cleanup, OTA rollout scheduling, two Influx disk queues, WebSockets, diagnostics, and optional stimulation loops.

The highest-impact confirmed findings are:

For the measured production RSS slope, the evidence-based suspect order is: **Bun/JSC allocator and page-return behavior first; Influx queue/file churn second; diagnostics churn third; JavaScript collections a distant last.** Seven maps are excluded by idle event inflow plus a linear-since-boot slope. `recentPublishes` is excluded by arithmetic (and Arm 0's priority size gauge), not by calling it event-driven. `heapUsed` is untrustworthy on 1.3.12 and is not part of that exclusion.

1. **P2 — Redis usage telemetry grows an unrotated ephemeral file for every Redis command.** The Redis client wraps all command methods and appends command details to `redis_usage.csv`; unlike the equivalent Influx log, no file-size rotation exists. Production has no persistent volume and low observed Redis activity, so this is per-deployment churn and launch-safety hygiene—not the measured RSS explanation.
2. **P1 — The HEAD default Influx durability path starts two 1-second disk pollers.** Disk queuing is enabled unless explicitly disabled. Metrics and compliance queues each perform filesystem checks every second, for 120 queue ticks/minute combined even when idle. Deployed SHA uses 5-second polling; compliance writes force `fsync` per append in both revisions.
3. **P1 — MQTT reconnect is infinite by default.** On broker failure the client retries every 2 seconds indefinitely (about 30 attempts/minute), while deferred startup can allow the HTTP process to remain live.
4. **P1 — Several async recurring paths can overlap.** Both Instagram schedulers, Redis synchronization, stimulation ticks, and device cleanup use `setInterval(() => void asyncWork())` without a shared in-flight guard. A slow execution can overlap its next interval.
5. **P1 — MQTT ingress and GMB enrichment have no global concurrency bound.** MQTT callbacks fire-and-forget one promise per message. Each accepted GMB webhook schedules a new `setImmediate` enrichment job. Traffic bursts can retain many requests, Mongo queries, API calls, and MQTT publishes concurrently.
6. **P1 — `recentPublishes` can retain entries indefinitely.** Every MQTT publish adds an entry; age-based cleanup occurs only on inbound messages. This is the only listed structure that can grow on a **timer** if something publishes on a cadence. It is still excluded on arithmetic (~0.6 MB/h at 60s / 10 KB) unless entries hold ~170 KB (they do not: key is topic + 100-char prefix + metadata). Arm 0 priority gauge: `recentPublishes.size`. `publishes`/`mqttMessages` increments are restored in Arm 0; they were stripped during v1/v5 inspection, not because counting was unsafe.
7. **P1 — Graceful shutdown omits the OTA scheduler and Loyalty WebSocket handle.** Their stop functions exist, but the handles are not invoked/stored. The current top-level shutdown eventually calls `process.exit`, masking this in normal termination but leaving lifecycle leaks for in-process restart/tests and making shutdown less reliable.
8. **P1 — Instagram polling scales per replica and is uncapped by default.** Every application replica starts both schedulers; there is no leader lease, and `IG_GLOBAL_FETCH_BUDGET_PER_MIN` defaults to `0` (unlimited). Local dedupe, backoff, and circuit state do not coordinate replicas.
9. **P1 — The local Docker health check performs a full Mongo device scan every 30 seconds.** Loopback `/health` calls execute `Device.find()` and materialize the complete collection, so the Docker `HEALTHCHECK` alone causes two full scans/minute.
10. **P2 — Production always runs diagnostics that write local files.** Leak diagnostics run every 30 seconds and memory logging every 60 seconds. Prometheus default metrics also start recurring collection at module import. The leak log is capped, but the work is unconditional and not feature-gated.
11. **P2 — Confirmed legacy/test-only modules remain in `src/`.** Daily POS metrics modules, an older Google Business API helper, unused webhook response helpers, and unused ACL type definitions are outside the production bundle.

No package dependency was conclusively unused. Several heavy dependencies are, however, loaded eagerly even when the associated feature is disabled.

## Production Runtime Map

> **Rate source:** This map describes current HEAD defaults. For live production decisions, use **Production Investigation — 2026-09-28** above. In particular, HEAD defaults Influx queues to 1 second while deployed SHA runs them every 5 seconds.

### Startup sequence

```text
Bun process
  -> dist/index.js (`package.json`, Dockerfile, railway.json)
  -> import StatsMqttLite and eager module graph
  -> construct StatsMqttLite
       -> load dotenv/config
       -> validate Mongo, Redis, MQTT, provisioning, and OTA configuration
  -> app.start()
       -> bind early HTTP liveness socket
       -> connect MongoDB (pool default min 2, max 10; command monitoring enabled)
       -> connect Redis
            -> wrap every Redis command for counters + CSV logging
            -> scan/migrate legacy device keys
            -> start 5-minute Redis synchronization
       -> create SessionService + 60-second cleanup timer
       -> create DeviceService + cleanup timer
       -> optionally initialize provisioning/CA/auth/user services
       -> create/connect MQTT client
            -> install broker listeners and infinite reconnect policy
       -> subscribe to 8 MQTT topic filters
       -> restore active devices from Redis
       -> serially republish IG, GMB, and loyalty state for active devices
       -> start Phase 2 in an unawaited promise
            -> create/health-check InfluxDB
            -> start two default 1-second Influx disk queues
            -> initialize PKI audit/transparency logs
            -> load latest device hash-chain state from InfluxDB
            -> start Instagram priority and background schedulers
            -> build/attach full Express application
            -> optionally initialize OTA and its 5-minute scheduler
            -> attach Loyalty WebSocket + 30-second ping timer
            -> create connect-refresh coordinator
            -> initialize optional stimulate service
            -> optionally start 10-minute self-keepalive
       -> start 30-second leak hunter
       -> start 60-second memory logger
```

Phase 2 is intentionally not awaited (`src/app.ts:313-317`). This improves MQTT ingress startup, but top-level `app.start()` resolves before the HTTP application, InfluxDB, pollers, and readiness state finish initializing.

### Runtime resource map

| Component | Trigger | Default frequency | MongoDB | Redis | MQTT | External/API or disk | Memory risk | CPU/I/O risk | Production required |
|---|---|---:|---:|---:|---:|---:|---|---|---|
| Early/full HTTP server | startup/requests | continuous | conditional | conditional | conditional | HTTP | Low | traffic-bound | Yes |
| Mongo connection pool | startup | continuous | 2–10 pooled connections | - | - | command monitor | Low | Low–Medium | Yes |
| Redis client | startup | continuous | - | one client + reconnect | - | CSV append for every command | queue bounded; disk unbounded | High disk I/O | Yes; CSV is not |
| MQTT client | startup | continuous | - | - | 1 client, 8 subscriptions | reconnect every 2s on outage | map risk | Medium–High on outage | Yes |
| Device cleanup | startup | 1h default | 1 `deleteMany`/tick | - | - | - | Low | Low; overlap theoretically possible | Yes |
| Session cleanup | startup | 60s | - | - | - | - | bounded/empty | Low | No meaningful current use |
| Redis sync | Redis startup | 5m | - | pipeline when dirty | - | - | dirty state retained | Low; overlap possible | Supporting |
| IG priority poller | Phase 2 | 15s | credential fallback | several when active | publishes results | Instagram API | per-device maps | High if fleet uncapped | Feature-dependent |
| IG background poller | Phase 2 | 90s | credential fallback | active/priority reads | publishes results | Instagram API | per-device maps | High if fleet uncapped | Feature-dependent |
| Prometheus default metrics | module import | library-defined recurring collection | - | - | - | process metrics | Low | Low | Supporting |
| Influx metrics disk queue | Phase 2 | 1s | - | - | - | 2 file stats/tick; writes/HTTP if queued | file read batches | Medium I/O | Supporting |
| Influx compliance disk queue | Phase 2 | 1s | - | - | - | same; `fsync` per append | file read batches | High I/O | Supporting |
| OTA rollout scheduler | OTA startup | 5m | rollout query | lock/heartbeat | possible OTA push | optional Slack | local fleet sets | Medium | OTA-dependent |
| Loyalty WebSocket ping | Phase 2 | 30s | - | - | WebSocket ping/client | - | per-IP map | Low–Medium | Loyalty-dependent |
| Loyalty active sweeps | first active flow | 1s and 5s | queries/updates | - | ack handling | WebSocket | connection map | Medium while active | Loyalty-dependent |
| Stimulate loops | startup if allowlist set | 30s/device/platform + lock refresh | conditional | lock/hash | publish | - | loop list/cache | High if accidentally enabled | Experimental |
| Self-keepalive | opt-in | 10m | - | - | - | localhost HTTP | Low | Low/unnecessary | No on Railway |
| Leak hunter | successful startup | 30s | - | counters only | counters only | local JSON append/rewrite | small bounded window | Medium disk churn | Diagnostic |
| Memory logger | successful startup | 60s | - | reads counters | counters | log sink | Low | Low | Diagnostic |
| GMB enrichment jobs | each accepted webhook | event-driven | 2+ queries/job | indirect | per-device publish | Google API | **unbounded jobs** | High on burst | Feature-dependent |

## Ranked Findings by Production Impact

### P0 — Critical

No P0 runtime issue is confirmed by the production measurements collected so far.

### P1 — High

#### P1.1 Default dual Influx disk polling

- **Evidence:** `src/config/influxConfig.ts:40-44` enables disk queues unless explicitly set false; default flush is 1,000 ms (`:51-54`). `src/services/influxService.ts:466-494` starts two queues. `src/services/influxDiskQueue.ts:81-84` starts each timer, and `:198-208` performs up to two file `stat` calls per tick.
- **Activity:** 60 ticks/minute per queue; 120 combined. When idle, up to 240 handled `stat` attempts/minute. Compliance appends force sync (`src/services/influxService.ts:482-489`).
- **Confidence:** Confirmed mechanism; production enablement follows default unless overridden.

#### P1.2 Infinite MQTT reconnect

- **Evidence:** `src/config/mqttConfig.ts:174-176` defaults reconnect to 2,000 ms and maximum attempts to `0`; `src/servers/mqttClient.ts:97-98, 147-152, 219-232` defines zero as infinite.
- **Activity during outage:** approximately 30 reconnect attempts/minute.
- **Impact:** sustained DNS/TLS/network/log activity for the outage duration. `MQTT_CONNECT_DEFERRED=true` permits the API to stay live while this continues.
- **Confidence:** Confirmed default.

#### P1.3 Async interval overlap

- **Device cleanup:** `src/services/deviceService.ts:448-450`.
- **Instagram:** `src/services/instagramService.ts:1301-1304`; scheduler bodies have no in-flight flag (`:1505-1641`).
- **Redis sync:** `src/services/redisSync.ts:27-31`.
- **Stimulate:** `src/services/stimulateService.ts:458-463`.
- **Impact:** if one run exceeds its interval, the next run starts anyway. Instagram's 15-second priority scheduler is the most exposed default path.
- **Confidence:** Confirmed.

#### P1.4 Unbounded event-driven work

- MQTT message handlers are invoked without awaiting or queueing at `src/app.ts:941-964`; the MQTT client invokes all matching handlers synchronously and those handlers launch promises (`src/servers/mqttClient.ts:350-361`).
- Every accepted GMB webhook calls `scheduleGmbEnrichment` (`src/webhooks/gmbHandler.ts:286`), which creates a `setImmediate` job (`src/webhooks/gmbEnrichmentWorker.ts:32-42`) with Google API, MongoDB, and per-device MQTT work. The route permits 200 requests/minute (`src/routes/webhookRoutes.ts:24-29`).
- **Impact:** no process-wide queue depth or concurrency ceiling; traffic bursts can create concurrent retained request state, queries, API calls, and publishes.
- **Confidence:** Confirmed mechanism; actual impact is traffic-dependent.

#### P1.5 `recentPublishes` retention

- **Evidence:** every successful publish adds an entry (`src/servers/mqttClient.ts:405-410`). Expired entries are swept only inside the inbound `message` listener (`:286-301`). There is no hard size cap or timer.
- **Impact:** a cadence publisher with little inbound traffic can grow the map linearly. Arithmetic at 60s / 10 KB/entry is ~0.6 MB/h; the map does not store full payloads. Priority Arm 0 gauge. Not the measured idle retainer unless size × estimated entry bytes tracks RSS.
- **Confidence:** Confirmed structure; excluded on arithmetic pending the size gauge.

#### P1.6 Startup work scales serially with active fleet

- Startup reads all active Redis set members (`src/services/startupCacheRepublish.ts:47-69`) and hydrates them sequentially (`:70-79`).
- It then loops all active devices sequentially and performs Instagram cache reads/publish, GMB resolution/publish, and loyalty idle work (`:190-224` and continuation).
- Before this, startup also scans legacy device keys on every Redis connection (`src/services/igDeviceRuntimeCache.ts:425-448`, called at `src/app.ts:585`).
- **Impact:** startup/readiness time and external work scale linearly with fleet size. The work occurs before Phase 2, so full HTTP route attachment is delayed.
- **Confidence:** Confirmed.

#### P1.7 Incomplete shutdown ownership

- `startRolloutScheduler` returns `stop()` (`src/jobs/rolloutScheduler.ts:70-75`), and `attachLoyaltyWs` returns `close()` (`src/servers/loyaltyWs.ts:81-85`).
- `StatsMqttLite.stop()` does not call `this.otaRolloutScheduler?.stop()`.
- `initializeHttpServer` discards the Loyalty WebSocket close handle (`src/bootstrap/httpRouteRegistry.ts:213-216`).
- **Impact:** timers/listeners are not owned by the application lifecycle. Top-level `process.exit` hides this in the normal signal path but not in in-process restarts or partial shutdowns.
- **Confidence:** Confirmed.

#### P1.8 In-memory structures without complete eviction

- `LocalDeviceBackoff.attempts` and `LocalFetchDedupe.last` never remove device keys (`src/services/igPollCoordination.ts:45-68, 111-121`).
- `DeviceStateLogService.chains` is populated for every observed device and has no removal (`src/services/deviceStateLogService.ts:27-40, 56-70`).
- Loyalty WebSocket `perIp` entries expire logically but are removed only if that same IP reconnects (`src/servers/loyaltyWs.ts:27-48`).
- Generic local TTL caches remove expired entries only when that exact key is read and have no maximum size (`src/services/localCaches.ts:3-17`).
- OTA local delivered sets are retained per release with no delivered-release eviction (`src/services/igPollCoordination.ts:143-217`).
- **Impact:** memory trends with cumulative unique devices, users, IPs, or releases rather than current activity. Same exclusion as the other event-driven maps: the idle replica is not supplying that inflow, and a linear ~10 MB/h slope is not a step function.
- **Confidence:** Confirmed structure; growth rate depends on churn. Not the measured idle retainer.

#### P1.9 Per-replica Instagram polling with unlimited default budget

- Each process starts priority and background schedulers at `src/services/instagramService.ts:1301-1304`.
- `IG_GLOBAL_FETCH_BUDGET_PER_MIN` defaults to `0` (`src/config/instagramPollingConfig.ts:54-59`), and the budget tracker treats non-positive limits as unlimited.
- Circuit, backoff, budget, dedupe, and fair-offset implementations are process-local. No leader lease or distributed scheduler ownership was found.
- **Impact:** background polling and external API work can scale approximately with replica count. Exact API calls remain fleet- and dedupe-dependent.
- **Confidence:** Confirmed architecture; actual replica count is deployment-dependent.

#### P1.10 Internal health materializes the full device collection

- Loopback or secret-authenticated `/health` calls invoke `getAllDevices()` (`src/servers/httpServer.ts:250-280`).
- `getAllDevices()` performs an unpaginated `Device.find()` and builds a second in-memory Map (`src/services/deviceService.ts:314-340`).
- Docker calls loopback `/health` every 30 seconds, so its health check alone causes two full collection scans/minute. Railway's probe source address determines whether it receives the lightweight or internal branch.
- **Impact:** MongoDB reads and process allocations grow with total historical device count, not active count.
- **Confidence:** Confirmed for Docker health checks; uncertain for Railway probe addressing.

#### P1.11 Deferred queue has no cardinality ceiling

- `DeferredDeviceWorkQueue` deduplicates by type/device but accepts unlimited distinct device IDs (`src/services/deferredDeviceWork.ts:53-91`).
- Stale items are removed only when a drain begins; there is no enqueue-time maximum or backpressure.
- **Impact:** a device/connect storm before or during Phase 2 can retain queue entries until processing catches up.
- **Confidence:** Confirmed structure; practical growth depends on ingress cardinality.

### P2 — Medium

#### P2.1 Always-on diagnostics

- Leak hunter starts unconditionally after startup (`src/index.ts:34-39`) and performs local file work every 30 seconds (`src/utils/leakHunter.ts:237-266`).
- It rotates its JSONL at 2 MB, so this is bounded disk capacity, but still two diagnostic ticks/minute plus latest-file rewrites.
- Memory logging runs every 60 seconds and serializes multiple subsystem snapshots.
- **Confidence:** Confirmed.

#### P2.2 Mongo command monitoring always enabled

- `monitorCommands: true` and a `commandStarted` listener count every operation (`src/services/mongoService.ts:60-91`).
- Useful for diagnostics, but it adds driver instrumentation to all production Mongo traffic with no configuration gate.
- **Confidence:** Confirmed.

#### P2.3 Background refresh and stale-while-revalidate can duplicate work

- `cachedQuery` launches untracked background refreshes for stale entries (`src/services/influxQueryCache.ts:56-64`) and has no per-key in-flight coalescing.
- Multiple requests for the same stale key can issue duplicate Influx queries.
- **Confidence:** Confirmed.

#### P2.4 Startup and lazy feature boundaries are inconsistent

- Loyalty service is genuinely lazy (`src/app.ts:970-985`), but its WebSocket server/ping is eager.
- OTA is conditional, but OCI SDK modules are imported by the startup graph before the condition.
- Swagger is disabled by default, but `swagger-jsdoc` and `swagger-ui-express` are imported eagerly.
- **Impact:** unnecessary startup memory/module initialization for disabled or rarely used features.
- **Confidence:** Confirmed import structure; exact package memory was not measured.

#### P2.5 Duplicate CORS policy layers

- The HTTP server already selects global, loyalty, and stimulate policies (`src/servers/httpServer.ts:118-145`).
- Loyalty and stimulate routers install CORS middleware again (`src/routes/loyaltyRoutes.ts:58-69`, `src/routes/stimOtaAdminRoutes.ts:59`).
- **Impact:** duplicate header/policy evaluation and greater risk of configuration disagreement; current CPU cost is low.
- **Confidence:** Confirmed.

#### P2.6 Unbounded Redis usage CSV

- **Evidence:** `src/services/redisService.ts:306-363` wraps every Redis command path. `src/services/redisService.ts:156-190` queues and appends a CSV row. There is no rotation or retention check analogous to `src/services/influxService.ts:207-219`.
- **Impact:** `data/redis_usage.csv` grows for the deployment lifetime and serializes command arguments. Production has no persistent volume and observed Redis command growth is low, so this is operational hygiene and a higher-traffic launch risk rather than the current RSS cause.
- **Secondary risk:** command arguments up to 2,000 characters increase allocation and ephemeral disk pressure.
- **Confidence:** Confirmed mechanism; exact file growth remains blocked on SSH access.

### P3 — Low

- Compiler diagnostics find stale imports, private fields, and compatibility members, but many apparent fields are mutated through the unsafe `BootstrapHost` cast and are not dead. These are maintenance issues, not runtime priorities.
- Session cleanup performs one empty-map sweep/minute; the cost is low but unnecessary.

## Unused Code

### A. Definitely unused in production

| File/module | Evidence | Indirect/dynamic check | Classification |
|---|---|---|---|
| `src/services/metrics/processDailyMetrics.ts` | No source/script import; only documentation references | Not in Bun entry bundle; no package/config registration | Dead/legacy |
| `src/services/metrics/dailyMetricsLua.ts` | Used only by dead `processDailyMetrics.ts` | Not in bundle | Dead/legacy |
| Most of `src/services/metrics/helpers.ts` | Referenced only by its unit test and docs | Not in bundle | Development/legacy |
| `src/webhooks/webhookHandlerError.ts` | No imports found | Not in bundle; no dynamic naming convention | Dead |
| `src/webhooks/webhookHandlerResponse.ts` | No imports found | Not in bundle; no dynamic naming convention | Dead |
| `src/types/acl.ts` | No imports found | Type-only; not dynamically loadable | Dead type definitions |
| `src/types/index.ts` | No imports found | Type barrel is not in build graph | Dead type barrel |
| `StatsMqttLite.initializeOtaServices()` | No callers; OTA initialization occurs through `httpRouteRegistry` | Compiler also reports it unused | Dead wrapper |

These are deletion candidates only after confirming no external TypeScript consumer imports this repository as a source package. The published package shape was not audited.

### B. Probably unused or legacy

| File/module | Evidence | Why not category A |
|---|---|---|
| `src/services/googleBusiness/googleBusinessApi.ts` | Imported only by `tests/unit/services/googleBusinessApi.test.ts`; absent from production bundle | Tests intentionally preserve the helper and may document expected API mapping |
| `SessionService` mutation API | `createSession`, `getSession`, update/delete, and client lookup are called only by unit tests | The service object remains production-referenced for `/ready` session count |
| `src/models/DeviceACL.ts` and model barrel export | No runtime service/route queries this model; only exported from `src/models/index.ts` | The barrel is imported by `UserService`, so Mongoose model registration may be an intentional side effect |
| Commented MQTT QoS2/onDelivered implementation | Large commented implementation remains in `src/servers/mqttClient.ts` | It may be retained as an explicit rollback/inspection reference |
| Temporary stimulate subsystem | Explicitly marked “remove after testing”; idle when allowlist is empty | It is configuration-reachable and therefore not dead |
| `scripts/attention-roadmap-smoke.ts` | Documentation names a `smoke:attention` command that is absent from `package.json` | It remains manually executable and may be operator tooling |
| `scripts/migrate-device-certificates-to-slots.ts` | No repository callers or package script | It may be a retained one-off production migration |

### C. Potentially used / do not delete

| Item | Why it looks unused | Indirect usage/uncertainty |
|---|---|---|
| `src/bootstrap/bootstrapHost.ts` | Absent from emitted JS | Type-only contract used throughout bootstrap |
| `src/lib/socials/types.ts`, `src/webhooks/types.ts`, `src/types/express.d.ts` | Absent from emitted JS | Compile-time contracts/declaration augmentation |
| `src/config/swaggerSchemas.ts` | No static import | Dynamically discovered by `swagger-jsdoc` when `SWAGGER_ENABLED=true` |
| Many `StatsMqttLite` fields/methods reported by `--noUnusedLocals` | TypeScript sees no direct reads | Bootstrap modules mutate/call them through `this as unknown as BootstrapHost` |
| Scripts under `scripts/` | Not production-imported | Operator, migration, PKI, validation, and OTA tooling |
| Recovery aliases and legacy Redis dual reads | Appear duplicative | Explicit migration/compatibility paths with TTL or deployed-client implications |

### Production vs legacy classification

- **Production-critical:** entry/bootstrap, HTTP, Mongo, Redis, MQTT, provisioning/CA, active-device state, route handlers.
- **Production-supporting:** Influx repositories, audit/transparency logs, Redis synchronization, startup cache republish, recovery flows.
- **Feature-critical when enabled:** OTA, loyalty, Instagram/GMB integrations.
- **Experimental:** stimulate service and non-production stimulate OTA UI.
- **Development/operator-only:** scripts, tests, local OTA helpers, smoke utilities.
- **Legacy/dead:** confirmed category A modules and likely category B helpers above.
- **Unclear:** Swagger dynamic schemas and compatibility/migration paths.

## Long-Running Processes

### 1. Device cleanup

```text
Component: DeviceService cleanup
Location: src/services/deviceService.ts:447-475
Started from: src/app.ts:464-466
Trigger: application startup
Frequency: configured in seconds and converted to ms; default 1h
Expected lifetime: process lifetime
Actual lifetime: until DeviceService.close()
Resources consumed: Mongo deleteMany, timer, logging
Can multiple instances start?: yes if initialize() is called twice; no guard
Can it leak?: timer is cleaned on normal app.stop
Can it overlap?: yes
Shutdown/cleanup: clearInterval in close()
Production necessity: required cleanup; the current 3600-second rate is operating as configured
```

### 2. Session cleanup

```text
Component: SessionService cleanup
Location: src/services/sessionService.ts:28-37
Started from: src/app.ts:460-462
Trigger: startup
Frequency: 60s
Expected/actual lifetime: process lifetime until close()
Resources consumed: scans in-memory session Map
Can multiple instances start?: initialize() has no guard
Can it leak/overlap?: synchronous scan; timer is cleaned
Shutdown/cleanup: clearInterval + Map.clear()
Production necessity: current production sessions stay empty; readiness reads count only
```

### 3. Redis synchronization

```text
Component: RedisSyncService
Location: src/services/redisSync.ts:24-81
Started from: src/app.ts:585-587
Trigger: successful Redis startup
Frequency: 5m
Expected lifetime: process lifetime
Resources consumed: dirty-cache traversal and Redis MULTI pipeline
Can multiple instances start?: singleton/start guard prevents duplicate timer
Can it leak?: dirty local entries can accumulate with device churn
Can it overlap?: yes; interval callback does not await/guard sync
Shutdown/cleanup: stopped/flushed only if Redis reports connected
Production necessity: supporting cache persistence
```

### 4. Instagram dual schedulers

```text
Component: Instagram priority/background pollers
Location: src/services/instagramService.ts:1265-1313, 1505-1641
Started from: src/bootstrap/serviceInitializer.ts:125-171
Trigger: Phase 2 when Redis is connected
Frequency: 15s priority; 90s background by default
Expected lifetime: process lifetime
Resources consumed: Redis, credential Mongo fallback, Instagram API, MQTT, per-device maps
Can multiple instances start?: poller running guard prevents duplicate start on one instance
Can it leak?: local backoff/dedupe maps retain unique device IDs
Can it overlap?: yes; no per-scheduler in-flight guard
Shutdown/cleanup: timers clear in stop()
Production necessity: Instagram feature
```

Default timer activity is 4 priority cycles/minute plus 0.67 background cycles/minute. API calls cannot be reduced to one fixed number: default caps and global budget are `0` (unlimited), and work depends on active/priority devices. Each direct fetch worker pool is bounded to four concurrent devices per invocation, but overlapping invocations are possible.

### 5. Influx queues

```text
Component: metrics + compliance InfluxDiskQueue
Location: src/services/influxDiskQueue.ts:81-194
Started from: src/services/influxService.ts:466-494
Trigger: Phase 2; enabled by default
Frequency: each 1s by HEAD code default; **deployed production is 5s** via `BATCH_TIMEOUT=5000`
Expected lifetime: Influx service lifetime
Resources consumed: filesystem stats/rename/read/write; Influx HTTP writes
Can multiple instances start?: two intentional instances; start() itself has no duplicate guard
Can it leak?: disk queue bounded per file; full file read allocates up to configured max lines
Can it overlap?: each queue has a flushing guard
Shutdown/cleanup: InfluxService.close() stops and drains both
Production necessity: durability feature; polling interval should be justified
```

### 6. OTA scheduler

```text
Component: OTA rollout scheduler
Location: src/jobs/rolloutScheduler.ts:24-76
Started from: src/bootstrap/otaServiceBootstrap.ts:80-86
Trigger: OTA enabled
Frequency: immediate, then 5m after completion
Expected lifetime: application lifetime
Resources consumed: Redis lock/heartbeat, Mongo release query, optional Slack and MQTT
Can multiple instances start?: distributed Redis lock limits active work, but multiple local timers can exist
Can it leak/overlap?: recursive timeout avoids self-overlap
Shutdown/cleanup: stop() exists but app.stop() never calls it
Production necessity: OTA rollout feature
```

### 7. Loyalty WebSocket and sweeps

```text
Component: Loyalty WebSocket ping
Location: src/servers/loyaltyWs.ts:23-85
Started from: src/bootstrap/httpRouteRegistry.ts:213-216
Trigger: Phase 2 HTTP attachment
Frequency: 30s
Expected lifetime: HTTP server lifetime
Resources consumed: WebSocket server/client set, ping loop, per-IP rate Map
Can multiple instances start?: yes if HTTP initialization repeats
Can it leak?: expired per-IP keys are not globally swept
Can it overlap?: synchronous ping iteration
Shutdown/cleanup: close() exists but returned handle is discarded
Production necessity: loyalty realtime feature
```

Loyalty Mongo sweeps are lazy: after unfinished work exists, ack sweeps run each second and session sweeps every five seconds (`src/services/loyaltyService.ts:242-278`). They stop when work is released or service stops.

### 8. MQTT connection and listeners

```text
Component: MqttClientManager
Location: src/servers/mqttClient.ts:109-363
Started from: src/app.ts:883-934
Trigger: startup
Frequency: continuous; reconnect every 2s on outage
Expected lifetime: process lifetime
Resources consumed: socket/TLS, keepalive, listeners, handler Map, ack timers, recent publish Map
Can multiple instances start?: app creates one; connect() has no explicit duplicate-connect guard
Can it leak?: recentPublishes can; pending acks have 30s expiry
Can it overlap?: message promises are not globally bounded
Shutdown/cleanup: client.end(true), ack/map clearing
Production necessity: core
```

Eight subscription filters are registered: active, LWT, status, telemetry, Instagram, GMB, promotion, and loyalty ack (`src/app.ts:937-992`). Reconnect re-calls subscription methods, but the handler Map keys overwrite the same patterns rather than accumulating handlers. MQTT.js `resubscribe: true` also resubscribes at the protocol level; the explicit re-subscribe is redundant work but not a confirmed duplicate-delivery bug.

### 9. Stimulate loops

```text
Component: StimulateService per-device/platform loops
Location: src/services/stimulateService.ts:100-172, 384-464
Started from: src/bootstrap/serviceInitializer.ts:190-202
Trigger: startup; active only with STIMULATE_DEVICE allowlist
Frequency: 30s tick default + lock refresh >=60s
Expected lifetime: until target reached/disconnect/process stop
Resources consumed: MQTT, Redis/hash/locks, local loop/cache state
Can multiple instances start?: start has running guard; reconnect replaces device loops
Can it leak?: loop list is explicitly stopped/filtered
Can it overlap?: async tick has no in-flight guard
Shutdown/cleanup: stop() clears timers/releases locks
Production necessity: experimental, normally none
```

### 10. Diagnostics and optional keepalive

- Leak hunter: 30 seconds, local JSONL/latest writes, capped at 2 MB (`src/utils/leakHunter.ts:27-39, 215-266`).
- Memory log: 60 seconds, log output (`src/index.ts:12-39`).
- Prometheus default process metrics: recurring collection starts at module import (`src/middleware/metrics.ts:5-6`); interval frequency is owned by `prom-client`.
- Self-keepalive: opt-in, 10 minutes, localhost `/health` fetch (`src/bootstrap/serviceInitializer.ts:205-228`).
- TokenStore cleanup: 60 seconds only when Redis is unavailable and the in-memory fallback is constructed (`src/storage/tokenStore.ts:35-44, 62-88`).

### 11. Request-scoped timers/retries

- MQTT wait-for-connection uses a poll interval plus timeout and removes both/listener on settle (`src/servers/mqttClient.ts:507-525`).
- MQTT publish retry is bounded by caller/default attempts with delay (`:532-608`).
- MQTT ack timers expire at 30 seconds and clear map entries (`:617-717`).
- Instagram rate-code retry is bounded to three retries with 1s/2s/4s delays (`src/services/instagramService.ts:442-446`).
- OCI retries are bounded and exponential up to 2s (`src/services/ociStorageErrors.ts:81-87`).
- Mongo retry utility is bounded by arguments (`src/utils/mongoRetry.ts`).
- HTTP probe/query/request abort timers are request-scoped and generally cleared.

## Event Listener Lifecycle

### Registered once and acceptably owned

- Process SIGTERM/SIGINT/unhandled rejection/exception listeners are top-level and process-lifetime (`src/index.ts:82-102`).
- Mongo connection listeners are installed after connection (`src/services/mongoService.ts:201-227`) and disappear with the connection/process.
- Redis connection listeners are installed once per client (`src/services/redisService.ts:475-487, 619-637`).
- HTTP temporary startup error listeners are removed after successful listen (`src/servers/httpServer.ts:63-68, 395-401`).
- Request/response/stream listeners are request-scoped.

### Accumulation or ownership risks

- `MqttClientManager.connect()` installs all listeners each time it is called and has no listener-installation guard. Current startup calls it once, so this is a latent lifecycle risk rather than an active leak.
- `StatsMqttLite` installs one `brokerConnect` listener; reconnect invokes three explicit resubscription paths while MQTT.js also has `resubscribe: true`.
- Loyalty WebSocket server and connection listener cannot be explicitly closed by `StatsMqttLite` because its handle is discarded.
- WebSocket `perIp` rate entries do not have a periodic sweep.
- Event handlers call async work with `void`, so EventEmitter/MQTT does not apply backpressure.

## Connection Lifecycle

### MongoDB

- One global Mongoose connection, reused by all models.
- Pool defaults: `minPoolSize=2`, `maxPoolSize=10` (`src/config/index.ts:279-282`, `src/services/mongoService.ts:60-70`).
- Retry reads/writes and command monitoring are enabled.
- Shutdown calls `mongoose.disconnect()`.
- No duplicate production connection was found. `UserService.disconnect()` could disconnect the shared global connection if called independently, but normal app shutdown uses `MongoService`.

### Redis

- One singleton `RedisService` and one node-redis client.
- Reconnect uses capped exponential delay and stops after more than 20 retries (`src/services/redisService.ts:437-444`).
- All command methods plus `sendCommand` and multi executor are wrapped for usage logging.
- Shutdown calls `quit()`/disconnect logic through `RedisService.disconnect()`.
- Deep import of `@redis/client/dist/...` relies on a transitive/internal package path rather than a declared direct dependency.

### MQTT

- One MQTT.js client with TLS, keepalive 45s, clean session, resubscribe enabled.
- Default reconnect is infinite.
- Explicit reconnect subscription calls overwrite handler Map entries; no confirmed handler multiplication.
- Disconnect clears pending ack timers and recent publishes.

### WebSocket

- One Loyalty `WebSocketServer` attached to the HTTP server.
- Active loyalty socket state is kept by device in `LoyaltyService`.
- Service stop closes mapped sockets, but the WSS ping/server handle is not owned by app shutdown.

### InfluxDB and HTTP SDKs

- One Influx client, two write APIs, one query API, and optionally two local WAL queues.
- Influx close drains queues and closes write APIs.
- Instagram direct fetch uses global `fetch`; no custom keep-alive pool is created in application code.
- OCI SDK client construction is feature-dependent, but the package is eagerly imported.

## Memory Risks

### Static JavaScript growth candidates — low-weight for the measured slope

1. MQTT `recentPublishes` lacks a size bound and time-based cleanup independent of inbound traffic.
2. Instagram local backoff/dedupe maps retain every unique device ID.
3. Device hash-chain map retains every initialized/observed device.
4. WebSocket per-IP map retains every unique IP until that exact IP returns after expiration.
5. Local TTL caches retain expired unique keys unless those keys are read again.
6. OTA delivered sets retain device IDs by historical version.
7. `OtaRedisState.deferredLogUntil` retains one entry per deferred device with logical expiry but no deletion (`src/services/otaService.ts:220-223, 411-416`).
8. Deferred work has no maximum number of distinct queued devices.

These structures are real static growth paths and remain worth gauging. The seven event-driven maps are a distant-last explanation because the idle window supplied no inflow that could produce a constant ~10 MB/h. `recentPublishes` is the cadence-shaped exception and is excluded on arithmetic until the size gauge confirms it:

| Structure | Grows on |
|---|---|
| MQTT `recentPublishes` | each **publish** (timer-shaped **if** publishes are cadenced; not event-inflow in the same sense as the others) |
| IG backoff / fetch dedupe | each unique device ID |
| WS `perIp` | each distinct socket IP |
| device hash chains | each observed device |
| OTA delivered sets | each release |
| deferred queues | each device storm |

The seven event-driven maps are excluded by idle inflow plus linearity. `recentPublishes` is excluded by **arithmetic** (and will be confirmed by the priority size gauge): ~0.6 MB/h at a 60s cadence and 10 KB/entry; ~170 KB/entry would be required to explain 9.85 MB/h. Live entries are a topic key, a 100-character payload prefix, a timestamp, and small metadata — not payload copies. No `setInterval` currently calls `mqtt.publish`. Production stimulate ticks skip while the device is inactive.

Instagram fetch counters were zero. HTTP requests were flat across the 499-minute series. Loyalty was dormant and OTA silent. MQTT activity increments were commented out on the characterized replica (v1/v5 inspection); Arm 0 restores them. Event-driven retention produces steps. The observed 9.83 / 9.90 / 9.84 MB/h is linear since boot: per-tick machinery (~1,440 Influx queue ticks + ~120 leak-hunter write cycles + ~280 IG scheduler ticks + ~120 WS pings + ~80 MQTT keepalives + ~60 logger serializations + stim skip-ticks + prom-client ≈ 2,000+ ops/h).

Add aggregate size gauges anyway: they are cheap, confirm this ranking under Arm 0, and belong in a later Bun issue report. Do not treat stale 1.3.12 `heapUsed` as the exclusion, and do not refactor these structures to chase the current RSS slope. Flat `external` / `arrayBuffers` still reduce Buffer-retention likelihood.

### Bounded structures

- MQTT ingress startup buffer has `MESSAGE_BUFFER_MAX` and drops oldest.
- MQTT pending ack Map entries have 30-second timers and clear on disconnect.
- Influx query cache is capped at 100 entries with 5-minute maximum age.
- Redis/Influx usage queues cap at 5,000 rows.
- Correlation timing map has a hard cap and batch eviction.
- Deferred work deduplicates per type/device, drops stale items after 30 seconds, limits retry to two attempts, and bounds OTA concurrency.
- TokenStore has TTL cleanup.
- Leak hunter history rotates at 2 MB.

### Allocation/concurrency risks

- Influx queue drains read the complete queue file into an array up to 100,000 lines before batching (`src/services/influxDiskQueue.ts:218-238`).
- Redis `getStats()` accumulates every matched key into an array before counting (`src/services/redisService.ts:663-671`).
- OTA rollout loads full eligible device and OTA-state collections (`src/services/otaService.ts:1568-1578`) and then performs per-device query pairs with concurrency up to 100 (`:1622-1629`).
- Internal Docker health checks load all devices into both a Mongoose result array and a Map twice per minute.
- Startup active-device republish is serial and retains per-device intermediate results only briefly, but can keep startup pending for a long fleet.
- GMB enrichment and MQTT ingress lack a shared concurrency bound.

## Database, Redis, MQTT, and API Activity

### MongoDB

- **Periodic query:** device cleanup runs one `deleteMany` per hour at defaults.
- **Health scan:** loopback Docker health checks execute an unpaginated `Device.find()` every 30 seconds.
- Loyalty active mode can run an ack sweep every second and session sweep every five seconds; exact query counts depend on helper branches and active documents.
- OTA scheduler queries all non-complete stable releases every five minutes.
- OTA fleet selection loads all eligible devices and all OTA states without pagination.
- OTA admin push loop performs `findOne` inside a `for...of` loop (`src/routes/otaAdminRoutes.ts:496-501`).
- Startup device-state logging reads latest chain rows for all known devices from Influx, not Mongo.
- Mongo command monitoring observes every database command.

### Redis

- Every operation incurs counting, argument transformation, CSV allocation, and append scheduling.
- Startup runs a SCAN migration for legacy device keys on every process boot.
- `getStats()` scans and retains every matching key, but is health/diagnostic request-driven rather than a timer.
- Instagram priority timer uses one Lua read/prune when local priority size is nonzero; background uses active-device data and a priority ZSET range read.
- Redis sync batches dirty state every five minutes.

### MQTT

- Eight wildcard subscriptions are active.
- Every inbound message linearly scans the small handler Map for topic matches.
- Every publish is entered into `recentPublishes`.
- Reconnect retries every two seconds indefinitely and executes explicit re-subscriptions after connection.
- Startup republishes cached Instagram, GMB, and loyalty screens for each recovered active device.

### External APIs

- Instagram priority and background timers may both trigger direct Graph API fetches. A 45-second local dedupe reduces duplicates but is not an in-flight promise coalescer.
- The fetch budget defaults to unlimited, and each replica owns independent schedulers and controls.
- Connect refresh can trigger immediate Instagram fetch in addition to scheduled polling.
- GMB connect pulls can fall back to live GBP API when Mongo context is absent.
- Every webhook can schedule independent GMB enrichment.
- OCI bucket verification is fire-and-forget at OTA initialization.
- Slack OTA alerts are fire-and-forget and failure-swallowed.

## Duplicate Runtime Responsibilities

### Device/activity state

Current state is distributed across Mongo `Device`, local active-device file/cache, Redis active set, Redis device hash, `IgDeviceRuntimeCache`, and OTA local tracker. Each has a reason (durability, restart recovery, hot path, rollout), but synchronization is spread across registration, LWT, five-minute sync, startup migration, and startup restore.

**Consolidation direction:** define one authoritative durable record plus one bounded process cache. Keep Redis only for cross-instance coordination/hot data and remove duplicate fields that do not need both Redis and local persistence.

### Screen refresh/publish

- Startup cache republish.
- ConnectRefreshCoordinator immediate pulls.
- Instagram priority timer.
- Instagram background timer.
- GMB webhook fast path.
- GMB enrichment republish.

These paths all converge on MQTT screen topics. Dedupe hashes reduce repeated payloads, but fetch/API work may already have happened.

**Consolidation direction:** use a keyed per-device/provider work coordinator that coalesces in-flight refresh requests before external API calls and publishes.

### Operational telemetry

- Prometheus metrics.
- Activity counters.
- Mongo command monitor.
- Redis command CSV.
- Influx operation CSV.
- Leak-hunter JSON.
- Minute memory logs.

This is more than one mechanism measuring similar query/resource activity.

**Consolidation direction:** retain Prometheus and sampled structured logs; make detailed CSV tracing opt-in and time-bounded.

### OTA state

OTA state exists in Mongo releases/device state, Redis rollout/lock state, and local fleet sets. Redis locks justify cross-instance coordination, but historical local delivered sets need explicit release eviction.

## Over-Engineering

### Unsafe bootstrap host façade

**Current architecture:** `StatsMqttLite` owns private state but casts itself via `this as unknown as BootstrapHost`; bootstrap modules mutate private fields and call private methods.

**Why it exists:** startup logic was split out of a very large application class without changing ownership.

**Why it may be unnecessary/costly:** TypeScript can no longer see real usage, producing many false unused diagnostics and making required lifecycle handles easy to omit. Initialization order is implicit in mutable optional fields.

**Simpler alternative:** create an explicit `RuntimeContext` object with public, typed resources and explicit `start()/stop()` handles, or return initialized subsystem handles from bootstrap functions.

### Full Redis command monkey-patching

**Current architecture:** imports node-redis internal command definitions, rewrites every command method, `sendCommand`, and multi executor to count and persist arguments.

**Why it exists:** detailed operational accounting.

**Why it may be unnecessary/costly:** relies on a transitive internal path, serializes every command, writes unbounded CSV, and duplicates Prometheus/activity diagnostics.

**Simpler alternative:** opt-in sampled instrumentation around domain-level Redis operations, with rotation and no payload values.

### Duplicate CORS routing policy

**Current architecture:** the HTTP server applies path-sensitive CORS and the loyalty/stimulate routers apply CORS again.

**Why it exists:** feature routers remain self-contained and may predate the central policy.

**Why it may be unnecessary/costly:** multiple policy sources can disagree and make access behavior difficult to reason about.

**Simpler alternative:** keep one path-aware policy owner in the HTTP server, with route modules declaring requirements rather than installing middleware.

### Multiple buffering/batching layers for Influx

**Current architecture:** application WAL files, one-second queue pollers, Influx SDK batch writers, explicit flush calls, and usage CSV logging.

**Why it exists:** durability/compliance and observability.

**Why it may be unnecessary/costly:** two queue systems and per-operation logging add timers, file I/O, allocation, and shutdown complexity.

**Simpler alternative:** select one durability owner. If the local WAL is required, use event-driven wakeup/backoff rather than 1-second idle polling and configure the SDK writer accordingly.

### Session service with no production sessions

**Current architecture:** an in-memory session CRUD service and minute cleanup timer exist so readiness can report a session count.

**Why it exists:** likely an earlier MQTT/session API.

**Why it may be unnecessary:** all mutation/read-by-id calls are test-only.

**Simpler alternative:** remove it from runtime after verifying no external route contract expects the readiness field, or replace the field with the actual Loyalty session metric.

### One process owns unrelated responsibilities

**Current architecture:** HTTP, MQTT ingress, external API polling, OTA rollout, compliance logging, WebSockets, and diagnostics share one event loop.

**Why it exists:** simple deployment and direct access to shared state.

**Why it may be costly:** disk stalls, API bursts, or scheduler overlap can affect MQTT ingress and health routes.

**Simpler alternative:** only after measuring contention, separate scheduled/external-fetch work into a worker process while preserving Redis/Mongo contracts. Do not split merely for style.

## Dependency Cleanup

No dependency is confirmed unused. Static production references exist for every runtime dependency:

- `@influxdata/influxdb-client`: Influx service/repositories.
- `@proof-socials/socials`: Instagram/GMB integration wrappers.
- Express middleware packages: HTTP server/routes.
- `google-auth-library`: GMB OAuth/PubSub/integration.
- `jsonwebtoken`: auth/provisioning/recovery.
- `mongoose`, `redis`, `mqtt`, `ws`: core connections.
- `node-forge`: CA/certificate validation.
- `oci-sdk`: OTA object storage.
- `prom-client`: metrics.
- Swagger packages: optional Swagger UI.
- `uuid`: correlation IDs and the otherwise-unused SessionService.
- `winston`: logging.

### Dependency risks/opportunities

| Package | Production usage | Impact/opportunity | Can remove? |
|---|---|---|---|
| `oci-sdk` | OTA/storage only | Heavy SDK imported eagerly through startup graph | No; lazy-load when OTA/storage is enabled |
| Swagger packages | Only when `SWAGGER_ENABLED=true` | Imported eagerly even when disabled | No; dynamic import inside enabled branch |
| `google-auth-library` | GMB only | Eager route/module graph import | No; lazy feature registration is possible |
| `node-forge` | Provisioning/PKI | Eager import in `app.ts` and CA modules | No; provisioning is default-enabled |
| `prom-client` | Metrics | Starts default process metric collection at import time | No; make collection explicitly owned/configurable |
| `uuid` | Correlation ID + legacy SessionService | Session usage disappears if service removed | Keep for correlation unless replaced |
| internal `@redis/client` path | Command telemetry | Not declared directly; internal API coupling | Remove deep import by simplifying instrumentation |

Development dependencies are not imported by production source. Docker copies the complete `node_modules` from the builder, including development dependencies installed by `bun install`; a production-only install/prune stage could reduce image size, but runtime correctness must be tested with Bun's lock/install behavior.

## Build and Runtime Bundle Impact

- The production build is a single ~0.83 MB application bundle with packages externalized; all package code is resolved from copied `node_modules` at runtime.
- Eager source imports cause optional feature packages to load during startup even if runtime configuration skips initialization.
- `node-forge` is also imported directly by `app.ts` for the rare create-client-certificate path, so that path cannot currently be lazy.
- `dotenv.config()` runs after the logger module import (`src/config/index.ts:1-10, 55-57`); logger configuration is corrected later, but import-time log settings may not see `.env`.
- Swagger's dynamic file globs expect `dist/config/swaggerSchemas.js` and `dist/routes/*.js`, but the Docker build emits only `dist/index.js`. When `SWAGGER_ENABLED=true`, schema discovery may therefore be incomplete. Verify before classifying `swaggerSchemas.ts` as dead.
- `config/swaggerSchemas.ts` is not included in the Bun entry bundle because it is only dynamically referenced by path.

## Quick Wins

1. **Gate Redis/Influx CSV usage tracing behind an explicit diagnostic flag; add Redis rotation.** Expected benefit: reduce per-command ephemeral disk work and improve launch safety. Do not expect this alone to change the current RSS slope.
2. **Store and close the Loyalty WebSocket handle; stop the OTA scheduler in `app.stop()`.** Expected benefit: complete lifecycle ownership with low behavior risk.
3. **Add in-flight guards to async intervals.** Expected benefit: prevent overlapping DB/API/Redis work during latency spikes.
4. **Add aggregate gauges; `recentPublishes.size` is the priority gauge.** Restore `publishes`/`mqttMessages` increments in the same change. Do not cap/sweep the map to chase the current RSS slope.
5. **Set a nonzero Instagram fetch budget and establish one polling owner per deployment.** Expected benefit: prevent replica-count multiplication and bound external API traffic.
6. **Make internal health counts aggregate queries or cached metrics instead of `Device.find()`.** Expected benefit: remove two full Mongo scans/minute under Docker.
7. **Test leak hunter and Prometheus default collection as isolated soak arms.** Keep the minute `memory_usage` logger enabled because it is the measurement instrument.
8. **Remove the production SessionService timer after readiness-contract verification.** Expected benefit: eliminate dead runtime state and one timer.
9. **Lazy-load Swagger, OCI, and rare certificate-generation modules.** Expected benefit: lower startup module load/memory for disabled features.
10. **Remove category A dead modules after external-package verification.** Expected benefit: less maintenance/bundle ambiguity; little direct runtime gain because they are already outside the bundle.
11. **Set finite, environment-appropriate MQTT reconnect policy or circuit reporting.** Expected benefit: contain outage traffic/log storms.

## Recommended Refactoring

### 1. Introduce explicit subsystem lifecycle handles

Have each initializer return `{ service, stop }` and aggregate those handles in reverse startup order. This directly addresses the missing WebSocket/OTA cleanup and removes reliance on the unsafe BootstrapHost cast.

### 2. Add keyed bounded work coordination

Use a per-device/provider in-flight map plus a small global concurrency pool for:

- MQTT registration/deferred work,
- scheduled and immediate Instagram refresh,
- GMB enrichment,
- startup republish.

The coordinator should coalesce duplicate keys and expose queue depth. Do not add a network queue until measured durability/cross-instance needs justify it.

### 3. Consolidate observability

Prefer Prometheus counters/histograms and sampled structured logs. Keep payload-level CSV traces opt-in, redact values, rotate them, and automatically expire the diagnostic mode.

### 4. Revisit Influx durability design

If compliance requires a local WAL, preserve it but wake the drain on enqueue and use bounded backoff after failures. Avoid two permanent one-second polling loops when files are empty.

### 5. Separate background workers only with measured evidence

Instagram/GMB external fetches and OTA rollout scheduling are the clearest isolation boundaries if measurements later show event-loop contention. Current production memory evidence does not justify a process split. Keep HTTP and MQTT together unless profiling demonstrates contention.

### 6. Define state ownership

Document authoritative ownership for device active status, screen counts, integration credentials, and OTA rollout state. Remove mirrors that do not serve restart, cross-instance, or latency requirements.

## Controlled RSS Soak Plan

Stop auditing. Intervene in this order, one knob per arm. Each arm should run for at least 12 hours at the observed ~9.9 MB/hour slope; preserve equivalent traffic and one replica.

**Arm 0 must pin `INFLUXDB_QUEUE_FLUSH_MS=5000`.** The banner documents the HEAD (1s code fallback) vs deployed (5s via `BATCH_TIMEOUT`) discrepancy; the plan has to act on it. Deploying HEAD unpinned can change the #2 suspect's tick rate 5× inside the baseline arm if `BATCH_TIMEOUT` is missing. The 1s code default is months old (`5f4d4a7`, 2026-07-24); if it is a deliberate drain-latency choice, give it its own later arm.

| Arm | Change | Question |
|---|---|---|
| 0 | Deploy HEAD with instrumentation/hygiene only: `Bun.gc(true)` pre/post RSS, selected smaps/status fields, file sizes/mtimes, aggregate gauges (**`recentPublishes.size` first**), watchdog (log-only), Redis CSV gate (opt-in), shutdown handles, restored publish counters, README flush-default correction. **Pin `INFLUXDB_QUEUE_FLUSH_MS=5000`.** Do not change Bun. | Does the climb reproduce on HEAD at the deployed 5s flush rate, and does forced GC flatten it? Does `recentPublishes.size` stay flat? |
| 1 | Change only Bun 1.3.12 → **1.4.2** after the full test suite and boot smoke (1.3→1.4 can carry behavioral changes). Primary runtime arm. | Dual value: (a) slope flattens → pin 1.4.2 and ship; (b) slope persists but `heapUsed` becomes trustworthy → JS question closes from gauges + a working heap metric + smaps. |
| 2 | Add only `bun --smol` | Is GC pacing/page retention responsible? |
| 3 | Disable only Influx disk queues | Is WAL timer/file churn responsible? |
| 4 | Disable leak hunter and Prometheus default collection | Is diagnostics churn responsible? |

Optional control, not in the main sequence: Bun 1.3.14. No RSS-fix claims in 1.3.13/1.3.14. A patch-stable slope would strengthen a later issue report; cut it to save a day if calendar matters.

Rules:

- Do not upgrade Bun in Arm 0; that would mix the code baseline with the runtime experiment.
- Pin Arm 0's Influx interval to **5000 ms** via `INFLUXDB_QUEUE_FLUSH_MS`. Do not rely on leftover `BATCH_TIMEOUT`. HEAD's 1-second code fallback would otherwise increase the leading I/O suspect by 5× and invalidate the baseline.
- Keep `memory_usage` logging enabled in every arm.
- Read and log only aggregate fields: pre/post-GC RSS; external/array buffers; structure sizes; Mongo slope; `/proc/self/smaps_rollup` `Rss`, `Private_Dirty`, and `Private_Clean`; `/proc/self/status` `VmRSS` and `VmData`; and size/mtime for Redis CSV, Influx WALs, and leak-hunter files.
- Treat Bun 1.3.12 `heapUsed` as advisory only because of the confirmed stale-full-GC reporting bug. Do not use it to rank JS suspects; rank them last on inflow and linearity. After Arm 1, a working `heapUsed` plus flat gauges closes JS from both sides.
- Sample Mongo device count infrequently; do not add it to the minute loop.
- If forcing a full GC every minute flattens RSS, that is a positive diagnosis of GC pacing/page retention, not a failed experiment.
- If RSS and post-GC RSS rise while JS-visible structures remain flat on 1.4.2, prepare a minimal Bun runtime issue with the smaps and arm results.

At the deployed 5-second interval, the two Influx queues execute approximately 1,440 timer ticks/hour. Leak hunter executes 120 file cycles/hour, Instagram schedulers approximately 280 no-op cycles/hour, Loyalty WebSocket pings 120/hour, MQTT keepalive (45s) approximately 80/hour, and the logger serializes 60 samples/hour, plus prom-client's own interval. Against a 9.9 MB/hour slope, only a few kilobytes retained/resident per recurring operation could explain the growth, making Arms 3 and 4 high-value discriminators.

If Arms 1–4 leave the slope unchanged, test the remaining per-tick paths individually. There is **no dedicated Instagram-poller-off flag** today (the poller starts whenever Redis is connected). An IG-off arm is cheap once a flag exists; until then, MQTT keepalive pings (45s) and IG no-op ticks are the leftover per-tick suspects. Do not combine fallback controls.

### Interim protection

The 06:31 restart bought runway (RSS back at the ~606 MB floor). Every Arm 0+ deploy restarts the process anyway. **Do not schedule a daily restart now.** Only act if Arm 0 slips more than ~3 days — then a manual Railway restart resets the clock. The watchdog in Arm 0 logs when RSS crosses `MEMORY_WATCHDOG_MB` (default 2048); it does not kill the process, so the soak slope stays measurable.

## Things NOT to Delete Yet

1. `src/config/swaggerSchemas.ts` — dynamically referenced; first fix/verify the single-file bundle glob behavior.
2. BootstrapHost-only fields/methods in `StatsMqttLite` — their usage is hidden behind an unsafe runtime cast.
3. Redis migration and legacy dual-read paths — confirm migration completion and TTL expiry in production.
4. Recovery route alias `/api/recovery` — deployed clients may still use it.
5. Stimulate code — explicitly experimental, but configuration-reachable; verify no production allowlist and obtain feature-owner signoff.
6. OTA local/Redis/Mongo state layers — complicated, but each participates in delivery, locking, or durability.
7. DeviceACL model registration — verify whether external collections or Mongoose side-effect registration are expected.
8. Operator scripts — not runtime code, but may be required for deployments, migrations, PKI, and incident response.
9. Influx compliance queue — high I/O, but may encode a durability requirement.
10. MQTT explicit re-subscription — likely redundant with MQTT.js, but test reconnect delivery before changing it.

## What I Would Investigate First

1. Pin `INFLUXDB_QUEUE_FLUSH_MS=5000` on the Arm 0 deploy (do not rely on leftover `BATCH_TIMEOUT`). Fold the README/code-default correction into that same change. Manual restart only if Arm 0 slips more than ~3 days.
2. Arm 0: forced-GC pre/post sampling, self-reported `/proc/self` + file metadata, **`recentPublishes.size` as the priority gauge**, restored publish counters, log-only watchdog, Redis CSV opt-in, OTA/WS shutdown handles. Do not change Bun.
3. Arm 1: Bun 1.4.2 after test suite + boot smoke. Slope-flat → pin and ship. Slope-persists → trustworthy `heapUsed` plus gauges closes JS from both sides.
4. Then `--smol`, Influx-WAL off, diagnostics off, one knob each.
5. Simulate broker outage and verify infinite MQTT reconnect effects on CPU, logs, and readiness.
6. Load-test MQTT ingress and GMB webhooks to determine safe global concurrency bounds.
7. Capture Instagram scheduler duration versus 15s/90s intervals and check for overlapping executions/API duplication.
8. Set a nonzero Instagram API budget/leader strategy before scaling beyond the confirmed single replica.
9. Measure loopback `/health` Mongo scans against total device count and replace full materialization.
10. Test graceful shutdown without the final `process.exit` to expose unclosed OTA/WebSocket/timer handles.
11. Profile cold startup with a realistic active-device set, including Redis migration and serial republish.
12. Verify Swagger in the Docker single-file bundle and confirm external consumers before deleting dead modules.

