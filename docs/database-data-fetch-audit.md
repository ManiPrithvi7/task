# Database Data Fetch Audit

**Scope:** MongoDB, Redis, and InfluxDB reads (and the writes that force extra reads) during server startup and device `/active` connection.

**Purpose:** Fact inventory for a senior DB architect discussion. This document does not prescribe a patch. It records what the process actually issues, where those calls sit on the path, and which of them are repeated for the same key on a single reconnect.

**Code snapshot:** `proofmqtt` as of 11 September 2026. Line numbers refer to current `src/` files.

**Related conversation log:** `audit.md` (research transcript). This file is the completed report.

---

## 1. How to read this

Two paths matter for “unwanted fetch on app connection”:

| Path | When it runs | Why it matters |
|------|----------------|----------------|
| **A. Process startup** | Once per process (`StatsMqttLite.start` → Phase 1, then Phase 2) | Restores every device still in the Redis active set and republishes screens. Cost scales with **N = active devices**, not with one reconnect. |
| **B. Device `/active`** | Every MQTT registration / reconnect | Cost is paid **per device reconnect**. Firmware reconnect storms multiply it. |

A third path, **timers**, keeps fetching after idle. It is listed so the architect can separate connect-burst load from background load.

**Severity in this document** means observed cost / duplication, not a security rating.

| Tag | Meaning |
|-----|---------|
| **REPEAT** | Same collection/key queried more than once for the same `deviceId` (or `businessId`) on one path |
| **WIDE** | Unbounded or decade-scale scan (no useful `limit` / time window) |
| **COLD** | Cache exists but the first hit after restart (or TTL expiry) falls through to origin |
| **N+1** | Loop issues one query per item instead of one batched query |
| **BLOCK** | Awaited on the MQTT `/active` handler before registration is considered complete |
| **BG** | Fire-and-forget or deferred; still hits the DB, not on the MQTT ACK critical path |

---

## 2. Executive findings

1. **A single existing-device reconnect issues 4–6 Mongo `Device.findOne({ clientId })` equivalents** before deferred work, plus more in deferred GMB/OTA/loyalty. The handler already has the document (or a mapping of it) from `getDevice` and from `cacheActiveDevice`, then queries it again for `businessId`.

2. **GMB resolution is a four-collection chain** (`Device` → `Social` → `GoogleBusinessProfile` → `GoogleBusinessLocation`) with **no shared request-scoped cache**. Startup republish, connect refresh, and integration-cache warm can each walk that chain independently for the same device.

3. **Instagram Social is loaded twice on `/active`** when the device has a `businessId`: once in `cacheActiveDevice` (`Social.findOne` INSTAGRAM), and again inside `cacheUserIntegrations` (`Social.find` all providers for that business).

4. **Loyalty idle publish (new on this path)** adds `Device.findOne` + `Business.findById` on every registration **and** on every startup republish per active device. It does not reuse the device document already in memory.

5. **InfluxDB chain hydration uses `range(start: -3650d)`** (ten years) for `device_state_log`, both as a bulk group query at Phase 2 start and as a per-device fallback on first transition if the in-memory map missed that device.

6. **Redis SCAN of `proof.mqtt:device:*` runs on every process start** (`migrateDeviceKeysToHash`), with `TYPE` + optional `GET` per key. A second SCAN (`getStats`, pattern `${prefix}*`) exists for stats/provisioning diagnostics.

7. **`DeviceCertificate.findOne` is uncached** on every `/active` (and `/status`, `/telemetry`) when `requireMtlsForRegistration` is on. HTTP mTLS middleware repeats the same query independently.

8. **Integration cache is process-local (24h TTL).** After restart every first connect (and startup republish) rebuilds it from Mongo. There is no Redis copy of `user:integrations:*`.

9. **Connect refresh and OTA delivery are already deferred** (`DeferredDeviceWorkQueue`) until Phase 2 is ready. The **blocking** waste is on the `/active` handler itself (duplicate Device/Social reads), not those deferred jobs.

10. **Source already flags this.** `deviceService.registerDevice` contains the comment: *“unwanted db calls are happening here, Since our device registeration topic will send the enough data to this function”* (`src/services/deviceService.ts:206`).

---

## 3. Path B — device `/active` (app connection)

### 3.1 Entry

Device publishes `{topicRoot}/{deviceId}/active`.

```
mqttClient message
  → app.onMqttMessageReceived
  → mqttIngressRouter.routeMqttMessage
  → handleCritical (/active)
  → runWithRegistrationRetry (up to 3 attempts, 1s apart)
  → handleDeviceRegistration (deviceRegistrationHandler.ts:167)
```

Retained `/active` is ignored. Lifecycle topics are **not** buffered behind `isServicesReady`; they run as soon as Phase 1 ingress is up.

### 3.2 Ordered fetch list (existing device, typical reconnect)

Assume: mTLS registration required, device already in Mongo, `businessId` set, Instagram + GMB linked, Redis up, in-memory caches empty (first reconnect after process start).

| # | Await? | Store | Operation | File:line | Same key already known? |
|---|--------|-------|-----------|-----------|-------------------------|
| 1 | **BLOCK** | Mongo | `DeviceCertificate.findOne({ device_id, status: active, expires_at: $gt now })` | `caService.ts:639` via `deviceProvisioningGate.ts:40` | No cache |
| 2 | **BLOCK** | Mongo | `Device.findOne({ clientId })` | `deviceService.ts:288` (`getDevice`) | First Device read |
| 3 | **BLOCK** | Mongo | `Device.updateOne({ clientId }, { $set firmwareVersion, lastSeenAt, … })` | `deviceRegistrationHandler.ts:217` | Write; not a fetch, but extra round-trip after #2 |
| 4 | **BG** | Mongo | `DeviceOtaState.findOne({ deviceId })` | `otaService.ts:1923` (`maybeRecordImplicitOtaSuccess`) | — |
| 5 | **BG** | Redis | `HGETALL` / `GET` `ota:active_release` | `otaService.ts:306/316` | — |
| 6 | **BG** | Influx | `writeOtaEvent` (write) | `deviceRegistrationHandler.ts:243` | — |
| 7 | **BLOCK** | Mongo | `Device.findOne({ clientId })` **REPEAT** | `deviceRegistrationHandler.ts:97` (`cacheActiveDevice`) | Same as #2 |
| 8 | **BLOCK** | Mongo | `Social.findOne({ businessId, provider: INSTAGRAM }).sort({ updatedAt: -1 })` | `app.ts:251` via `loadLatestInstagramSocialForUser` | — |
| 9 | **BLOCK** | Redis | `HSET` + `EXPIRE` `proof.mqtt:device:{id}` | `igDeviceRuntimeCache.ts:466` | Write |
| 10 | **BLOCK** | Redis | `SADD` + `EXPIRE` `proof.mqtt:active:devices` | `app.ts:206` | Write |
| 11 | **BLOCK** | Mongo | `Device.findOne({ clientId }).select({ businessId: 1 }).lean()` **REPEAT** | `deviceRegistrationHandler.ts:258` | Same as #2 and #7 |
| 12 | **BG** | Influx | `queryLatestDeviceStateEntry` if chain not in memory **WIDE** (`-3650d`) | `deviceStateLogService.ts:65` | Then writes `device_state_log` + `device_active` |
| 13 | **BG** | Mongo | `Social.find({ businessId })` + `GoogleBusinessProfile.find` + `GoogleBusinessLocation.findOne` | `userIntegrationCache.ts:99,75,79` | Instagram Social already read in #8 |
| 14 | **BG** | Mongo | `Device.findOne({ clientId })` **REPEAT** + `Business.findById` | `publishLoyaltyIdle.ts:12,15` | Device already loaded in #7 |
| 15 | **BG** (deferred) | Local + Mongo | `getUserIntegrations` — local TTL hit if #13 finished; else **REPEAT** of #13 | `connectRefreshCoordinator.ts:33` | Race with #13 |
| 16 | **BG** (deferred) | Redis | `ZSCORE` → `ZADD` → `ZCARD` on `priority_zset` | `instagramService.ts:1329-1351` | Then Graph/serverless fetch (not DB) |
| 17 | **BG** (deferred) | Mongo | `resolveGmbContextForDevice`: Device + Social(GMB) + GBProfile.find + GBLocation.findOne **REPEAT** of GMB half of #13 | `resolveDeviceGmb.ts:22-52` | Same business, same four collections |
| 18 | **BG** (deferred OTA) | Mongo + Redis | `Device.findOne`, `DeviceOtaState.findOne`, `FirmwareRelease.findOne`, Redis active release | `otaService.ts:1491-1498` | Device already known |

**New-device first registration** adds `registerDevice`: another `Device.findOne` (`deviceService.ts:208`) after `getDevice` already returned null, then `device.save`, then `DeviceOtaState.updateOne` upsert. Comment at `deviceService.ts:206` records this as known waste.

### 3.3 Repeat Device lookups on one `/active`

For an **existing** device, `Device.findOne({ clientId })` (or `updateOne` on the same filter) is issued at:

1. `getDevice` — decide new vs existing  
2. `Device.updateOne` — firmware / lastSeen  
3. `cacheActiveDevice` — full document for hash + Instagram  
4. `handleDeviceRegistration` line 258 — `businessId` only  
5. `publishLoyaltyIdleForDevice` — `businessId` again  
6. Deferred `resolveGmbContextForDevice` — `businessId` again  
7. Deferred OTA `deliverPendingToDevice` — full device again  

Items 3–5 are sequential on the same tick and do not share a local variable. The document from step 3 already has `businessId`.

### 3.4 GMB four-hop chain (copied in three call sites)

Same logical join, no shared helper cache:

| Call site | Trigger |
|-----------|---------|
| `userIntegrationCache.resolveGmbLocationId` | Integration cache build (`Social.find` then Profile + Location) |
| `lib/socials/resolveDeviceGmb.ts` | Startup republish, connect pull, GMB screen |
| `webhooks/resolve/gmbSocial.ts` | Webhook path (same shape) |

Each hop is a separate round-trip. `GoogleBusinessProfile.find({ socialId })` is not `findOne`; it loads all profiles for the social, then `GoogleBusinessLocation.findOne({ profileId: { $in } }).sort({ updatedAt: -1 })`.

### 3.5 What is already off the MQTT critical path

These are **not** blocking registration ACK:

- Implicit OTA success check  
- Influx OTA event + device state log  
- Integration cache warm  
- Loyalty idle MQTT publish  
- `enqueueConnectRefresh` (Instagram priority + GMB pull)  
- `deliverOtaOnRegistration`  

They still generate origin load during a reconnect storm. A 50-device simultaneous reconnect after a broker blip will schedule 50× of #12–#18.

### 3.6 mTLS certificate lookup (uncached)

When `requireMtlsForRegistration` is true:

- Every `/active`, `/status`, `/telemetry` → `DeviceCertificate.findOne` (`deviceProvisioningGate.ts:40`).  
- HTTP device routes using `requireMtlsDeviceCert` → **the same query again** (`mtlsAuth.ts:121`).  

No Redis/local TTL. Filter: `device_id` + `status: active` + `expires_at > now`. Full certificate document is returned (no `.select()` / `.lean()` on the gate path).

---

## 4. Path A — process startup

### 4.1 Phase 1 (blocks `isIngressReady`)

| Step | Store | Fetch | Blocks ingress? | Fatal on fail? |
|------|-------|-------|-----------------|----------------|
| `initializeMongoDB` | Mongo | `mongoose.connect` only | Yes | Yes |
| `initializeRedis` | Redis | Connect + PING | Yes | Yes (if Redis enabled) |
| `migrateDeviceKeysToHash` | Redis | **SCAN** `proof.mqtt:device:*` COUNT 100; per key `TYPE`, maybe `GET`/`DEL`/`HSET` | Yes | Throws → fatal |
| `getRedisSyncService().start` | Redis | No fetch; 5 min interval later | No | — |
| `initializeProvisioning` (if mTLS) | Mongo | `UserService.initialize` may hit Business (see §6.1); CA is filesystem | Yes | Yes |
| MQTT connect | — | DNS/TLS, no DB | Yes | Yes |
| Topic subscribe | — | No DB | Yes | Yes |

After `isIngressReady = true`, **before** Phase 2:

### 4.2 Active restore + screen republish (blocks start() but non-fatal)

`restoreActiveAndRepublishFromCache` (`app.ts:477`):

1. **Redis `SMEMBERS proof.mqtt:active:devices`** (`startupCacheRepublish.ts:57`). Full set, no cursor.  
2. For each member **not** already in the local file cache: `cacheActiveDevice` → Mongo `Device.findOne` + `Social.findOne` Instagram + Redis `HSET` device hash. **N+1.**  
3. For **every** locally active device (including those just hydrated):

   | Screen | Fetches |
   |--------|---------|
   | Instagram | Redis `HGETALL proof.mqtt:device:{id}`; on miss `HGET ig_follower_count` |  
   | GMB | `resolveGmbContextForDevice` (4 Mongo hops) + `getUserIntegrations` (Mongo on miss) + Redis `GET gmb:reviews:{locationId}` |  
   | Loyalty idle | `Device.findOne` + `Business.findById` **per device** |

If Redis still lists 200 “active” devices after a long process downtime, startup issues **200 Device.findOne + 200 Social Instagram** on hydrate (for those missing locally), then **200 GMB 4-hop chains + 200 Device+Business loyalty lookups** on republish.

`SMEMBERS` on a large set is O(N) and blocks that Redis connection until the full reply is sent.

### 4.3 Phase 2 (background, `void initializePhase2()`)

| Step | Store | Fetch | Notes |
|------|-------|-------|-------|
| Influx `healthCheck` | HTTP | `/health` + `/api/v2/buckets` × 2 (metrics + compliance) | 3–7 HTTP calls with retries |
| `auditService.initialize` | Influx | `queryLatestAuditEntry` — `pki_audit`, `range(start: 0)`, `limit(1)` | All-time, one row |
| `transparencyLog.initialize` | Influx | `queryTransparencyLeaves` — `ct_log`, `range(start: 0)`, **no limit** **WIDE** | Full leaf set into memory |
| `deviceStateLog.initialize` | Influx | `queryLatestDeviceStateEntries` — `device_state_log`, **`-3650d`**, group by `device_id`, limit 1 per group **WIDE** | Seeds in-memory hash chain |
| Instagram poller `start` | Redis | SCRIPT LOAD + `ZCARD priority_zset` | Then interval schedulers |
| OTA bootstrap | Mongo | `FirmwareRelease.updateMany` backfill (write); `queryOtaReleaseLeaves` (`range(start: 0)`, no limit) | Fire-and-forget |
| HTTP listen | — | Bind only | — |
| StatsPublisher `start` | Local file | `getAllActive()`; 60s interval | Comment says Redis; implementation is local active-device cache |
| `processDeferredWork` | Mixed | Drains connect_refresh / OTA queued during Phase 1 | Can pile Mongo/Redis if devices connected during warmup |

---

## 5. MongoDB inventory

### 5.1 Collections touched on connect / startup

| Collection | Typical filter | Connect | Startup restore | Notes |
|------------|----------------|---------|-----------------|-------|
| `Device` | `{ clientId }` | Heavy **REPEAT** | Per hydrating device + loyalty + GMB | No projection on `getDevice` / `cacheActiveDevice` |
| `Social` | `{ businessId, provider }` or `{ businessId }` | Instagram one-doc + all-provider find | Same | Access tokens in documents |
| `GoogleBusinessProfile` | `{ socialId }` | Integration cache + GMB resolve | Per device GMB republish | `_id` only in some paths |
| `GoogleBusinessLocation` | `{ profileId: $in }` | Same | Same | Full document in `resolveDeviceGmb` (`.lean()`, no select) |
| `Business` | `findById` | Loyalty idle | Loyalty idle per device | `name` only |
| `DeviceCertificate` | `{ device_id, status, expires_at }` | Gate | Optional client-cert ensure | Uncached |
| `DeviceOtaState` | `{ deviceId }` | Implicit OTA + deferred OTA | — | |
| `FirmwareRelease` | status/version | Deferred OTA | Scheduler / backfill | |
| `LoyaltySession` / `LoyaltySpin` | status windows | Not on `/active` | Sweeps if unfinished work | See §8 |

### 5.2 Server startup Mongo (Phase 1 / OTA)

| Site | Op | When |
|------|----|------|
| `userService.ts:139` | `Business.countDocuments({})` | Diagnostic inside `verifyUserExists` (auth path, not boot unless called) |
| `userService.ts:166` | `Business.find({}).limit(5)` | Diagnostic when user not found |
| `FirmwareRelease.ts` via OTA bootstrap | `updateMany` stage backfill | Phase 2, fire-and-forget |
| `caService.ts:527` | `DeviceCertificate.findOneAndUpdate` | Optional `CREATE_MQTT_CLIENT_CERT` |

### 5.3 Connect / MQTT Mongo (besides §3)

| Site | Op | Trigger |
|------|----|---------|
| `deviceService.ts:379` | `Device.updateOne` lastSeen | Non-lifecycle messages |
| `otaRegistrationCoordinator.ts:139` | `DeviceOtaState.findOne` | OTA on registration |
| `otaService.ts:845,869,873` | Device + OtaState + `FirmwareRelease.find` | `resolveUpdate` |
| `otaService.ts:1572,1576` | `Device.find({…})` + `DeviceOtaState.find({})` | Fleet / TEST_OTA fan-out — **WIDE** OtaState find |

### 5.4 HTTP Mongo (not connect, but same collections)

| Site | Op | Cache? |
|------|----|--------|
| `mtlsAuth.ts:121` | `DeviceCertificate.findOne` | No |
| `dashboardRoutes.ts:32` | `Device.findOne` ownership | No |
| `provisioningRoutes.ts:582-584` | Device by clientId then macID | No |
| `otaAdminRoutes.ts` | FirmwareRelease + per-device `DeviceOtaState.findOne` in loops | **N+1** on some push paths (`otaAdminRoutes.ts:496`) |
| `integrationRoutes.ts` | Social + locations | No |
| `lifecycleRoutes.ts` | DeviceCertificate / Device | No |

### 5.5 L3 runtime-cache miss (`queryMongoDeviceState`)

`igDeviceRuntimeCache.ts:326-376` — **not** called from `/active` itself; used when Instagram/GMB publish needs runtime state and L1/L2 miss:

1. `Device.findOne` (projected)  
2. `DeviceOtaState.findOne`  
3. `Social.findOne` INSTAGRAM  
4. `Social.findOne` GMB  

Four sequential queries, then Redis hash backfill.

### 5.6 Unbounded / weakly bounded Mongo

| Site | Op | Bound |
|------|----|-------|
| `deviceService.ts:320` | `Device.find()` | **None** — all devices |
| `otaService.ts:1576` | `DeviceOtaState.find({})` | **None** |
| `loyaltyService.ts:794` | `LoyaltySession.find({ status: SPINNING })` | Status only |
| `userService.ts:139` | `countDocuments({})` on Business | Collection scan for a debug log |

---

## 6. Redis inventory

### 6.1 Key patterns (`src/constants/redisKeys.ts` + ad-hoc)

| Pattern | Type | Role |
|---------|------|------|
| `proof.mqtt:device:{deviceId}` | HASH | Runtime device state (IG tokens, followers, OTA, status) |
| `proof.mqtt:active:devices` | SET | Who was active across process restart |
| `priority_zset` | ZSET | Instagram attention / priority poll |
| `{prefix}ota:active_release` | HASH (legacy STRING) | Current OTA offer |
| `prov:{token}` | HASH | Provisioning tokens |
| `gmb:reviews:{locationId}` + `gmb:reviews:ts:{locationId}` | STRING | Review count cache |
| `csr:global:{minute}`, `csr:ip:{ip}` | STRING | CSR rate limit (Lua) |
| `{prefix}recovery:session:{deviceId}` | STRING | Recovery session |
| `{prefix}ota:check:{deviceId}` | STRING | OTA report SET NX |
| `webhook:dedupe:*` | STRING | Webhook dedupe |
| Legacy `device:followers:*`, `device:fetch_history:*` | STRING/ZSET | Still DEL’d on LWT |

### 6.2 Startup Redis

| Op | Site | Cost |
|----|------|------|
| SCAN `proof.mqtt:device:*` + TYPE/GET per key | `migrateDeviceKeysToHash` `igDeviceRuntimeCache.ts:403` | **WIDE**, every boot, even if nothing left to migrate |
| SMEMBERS `proof.mqtt:active:devices` | `startupCacheRepublish.ts:57` | Full set |
| HGETALL per device | Republish Instagram | N hashes |
| HGET `ig_follower_count` | Fallback if L1 empty | Extra RTT after HGETALL already loaded the hash |
| SCRIPT LOAD | IG poller + CSR Lua | Once |

`readFollowerCountForRepublish` (`igDeviceRuntimeCache.ts:508`) checks L1 first; republish already `HGETALL`’d and hydrated L1, so the HGET fallback should usually skip. If hydration failed, HGET is a second round-trip for a field that HGETALL would have returned.

### 6.3 Connect Redis

| Op | Site |
|----|------|
| HSET+EXPIRE device hash | `writeDeviceHashOnConnect` |
| SADD+EXPIRE active set | `redisMarkDeviceActive` |
| ZSCORE, ZADD, ZCARD, maybe ZREMRANGEBYRANK | `markPriority` on connect refresh |
| EVALSHA IG fetch budget/dedupe | `requestImmediateFetch` |
| HGETALL ota active_release | Implicit OTA / delivery |
| LWT: SREM, HSET inactive, ZREM, DEL legacy keys | Disconnect |

`markPriority` is a client-side **read-modify-write** (ZSCORE then ZADD), not a single Lua. The interval scheduler uses Lua (`evalAtomicPriorityReadAndPrune`) for prune.

### 6.4 SCAN / stats

`RedisService.getStats` (`redisService.ts:663-671`) SCAN-matches `${keyPrefix}*` COUNT 1000 until cursor 0, then `INFO memory`. Used from provisioning token stats (`provisioningService.ts:279` → `tokenStore.getStats`, which SCANs `prov:*` separately at `tokenStore.ts:409`).

Not on the `/active` path. Expensive if someone hits a stats/health helper that calls it under load.

### 6.5 Caching layers in front of Redis

| Data | L1 | L2 Redis | L3 |
|------|----|----------|----|
| Device runtime | In-memory `IgDeviceRuntimeCacheImpl` | HASH `proof.mqtt:device:*` | Mongo `queryMongoDeviceState` |
| Active devices | Local file store | SET (membership only, not full record) | Mongo via `cacheActiveDevice` |
| User integrations | In-memory TTL 24h | **None** | Mongo Social/GMB |
| Prov tokens | `LocalProvCache` | HASH + legacy STRING | — |
| GMB review count | Runtime field | STRING | Mongo location `verifiedReviewCount` |
| OTA fleet | Local tracker | HASH active_release | Mongo FirmwareRelease |

---

## 7. InfluxDB inventory

### 7.1 Query methods (`influxService.ts`)

| ID | Method | Bucket | Measurement | Range | Limit | Connect/startup? |
|----|--------|--------|-------------|-------|-------|------------------|
| Q8 | `queryLatestDeviceStateEntry` | compliance | `device_state_log` | **-3650d** | 1 | First transition if chain missing |
| Q9 | `queryLatestDeviceStateEntries` | compliance | `device_state_log` | **-3650d** | 1 per `device_id` | Phase 2 init |
| Q14 | `queryLatestAuditEntry` | compliance | `pki_audit` | `start: 0` | 1 | Phase 2 init |
| Q16 | `queryOtaReleaseLeaves` | compliance | `ota_release_log` | `start: 0` | none | OTA bootstrap |
| Q17 | `queryTransparencyLeaves` | compliance | `ct_log` | `start: 0` | none | Phase 2 init + verify API |
| Q1–Q7, Q10–Q13, Q15, Q18 | Dashboard / proxy / verify | metrics or compliance | various | caller or `-90d` / `0` | mixed | HTTP only |

`queryDeviceActive` (Q7) is defined and **has no production caller**.

### 7.2 Flux for Q9 (startup)

```flux
from(bucket: "<compliance>")
  |> range(start: -3650d)
  |> filter(fn: (r) => r._measurement == "device_state_log")
  |> filter(fn: (r) => r._field == "hash" or r._field == "sequence")
  |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> group(columns: ["device_id"])
  |> sort(columns: ["_time"], desc: true)
  |> limit(n: 1)
```

Influx still evaluates the range filter over ten years of `device_state_log` before grouping. Storage engine may prune by shard, but this is the widest default in the codebase.

Q8 is the same window for **one** `device_id` — paid on connect if Phase 2 init failed, raced, or the device was unseen in the bulk map.

### 7.3 Writes on connect (not fetches, but they share the write path / disk queue)

| Write | Measurement | Caller |
|-------|-------------|--------|
| `writeOtaEvent` | `device_ota_events` | `/active` |
| `writeDeviceStateLog` | `device_state_log` | `recordTransition` |
| `writeDeviceActive` | `device_active` | `recordTransition` |

Timers: disk-queue flush and client `flushInterval` are **writes**, not queries.

### 7.4 Dashboard query cache (`influxQueryCache.ts`)

Stale-while-revalidate: 30s fresh / 120s stale (audit route 15s/60s).

**Cached:** Instagram summary, GMB summary, device audit.  
**Not cached:** GMB reviews, velocity, webhooks, device baseline.

Unrelated to MQTT connect except that connect-time Instagram/GMB **writes** invalidate those cache prefixes.

### 7.5 Health check HTTP

`healthCheck` (`influxService.ts:1071+`): GET `/health` (1–3 attempts) + GET `/api/v2/buckets?org=` twice (metrics bucket, then compliance bucket). Same buckets list endpoint, two sequential calls.

---

## 8. Timers (background fetch after connect)

| Timer | Interval | DB | Runs when idle? |
|-------|----------|----|-----------------|
| Device cleanup | constructor default 3600s | Mongo `Device.deleteMany` OFFLINE + stale `lastSeenAt` | Yes |
| RedisSync | 5 min | Redis pipeline HSET dirty hashes | Only if dirty flags |
| IG priority scheduler | `priorityIntervalMs` | Redis EVALSHA on `priority_zset` | Yes if poller started |
| IG background scheduler | `backgroundIntervalMs` | Redis `ZRANGEBYSCORE` | Yes |
| StatsPublisher | 60s default | Local active list; `getUserIntegrations` per device (Mongo on miss) | Yes if devices in cache |
| Loyalty ACK sweep | 1s | `LoyaltySpin.find` stale + due | **Only while sweeps armed** (unfinished work) |
| Loyalty session sweep | 5s | `LoyaltySession.find` + **N+1** `LoyaltySpin.findOne` per session | Same |
| Rollout scheduler | recursive timeout | Mongo `FirmwareRelease.find` | Yes if OTA on |
| Influx disk queue | `flushIntervalMs` | Influx writes | If queue non-empty |
| Session / token cleanup | in-memory | Local maps | Yes |
| Keep-alive | 10 min | HTTP GET `/health` | Yes |
| Memory log | 60s | None | Yes |

Loyalty: `start()` → `recoverIfNeeded` → `hasUnfinishedLoyaltyWork` (`LoyaltySpin.exists` + `LoyaltySession.exists`). Sweeps **do not** run if both are empty. Once armed, `sweepSessions` does **N+1** `LoyaltySpin.findOne` inside the idle-session loop (`loyaltyService.ts:785-789`) and again for every `SPINNING` session (`794-799`).

---

## 9. Catalog of unnecessary / duplicate fetches

Use this table in the architect review. “Unnecessary” here means **the process already has the data in a previous result or a cache that was just written**, or the scan is far wider than the datum required (latest hash/sequence).

| ID | Path | Store | What happens | Why it is extra |
|----|------|-------|--------------|-----------------|
| R1 | `/active` | Mongo Device | `getDevice` then `cacheActiveDevice` findOne | Same `clientId`, milliseconds apart |
| R2 | `/active` | Mongo Device | Line 258 findOne for `businessId` | `cacheActiveDevice` just loaded full doc |
| R3 | `/active` | Mongo Device | Loyalty idle findOne | Same as R2 |
| R4 | `/active` new device | Mongo Device | `getDevice` null then `registerDevice` findOne | Comment at `deviceService.ts:206` |
| R5 | `/active` | Mongo Social | Instagram `findOne` in cacheActiveDevice **and** `Social.find` in `cacheUserIntegrations` | Same business, same provider row |
| R6 | `/active` + deferred | Mongo GMB chain | Integration cache build **and** `resolveGmbContextForDevice` | Same four collections |
| R7 | `/active` vs deferred | Integrations | `cacheUserIntegrations` then `getUserIntegrations` | Second call should hit L1; race can double-build |
| R8 | `/active` | Mongo DeviceCertificate | Every lifecycle message | No TTL; cert rarely changes |
| R9 | Startup | Redis | SCAN all device keys to migrate STRING→HASH | Migration may be complete; still scans every boot |
| R10 | Startup republish | Redis | HGETALL then possible HGET same hash field | Field was in HGETALL |
| R11 | Startup republish | Mongo Device+Business | Loyalty idle per active device | Device already hydrated |
| R12 | Startup republish | Mongo GMB × N | Full 4-hop per device | No batch `$in` on clientIds |
| R13 | Phase 2 | Influx | `-3650d` all devices’ latest chain | Only `{device_id, sequence, hash}` of **latest point** needed |
| R14 | Connect | Influx Q8 | Same 10-year range per unknown device | Duplicate of R13 if init already loaded that id |
| R15 | Phase 2 | Influx | `queryTransparencyLeaves` / OTA leaves `range(0)` no limit | Full history into RAM |
| R16 | Health | Influx HTTP | Two identical `/api/v2/buckets` calls | One response contains both bucket names |
| R17 | Loyalty sweep | Mongo | `findOne` spin per session | Batch `sessionId: { $in }` |
| R18 | OTA admin / some fleet paths | Mongo | Per-device findOne in loop | `$in` on deviceIds |
| R19 | `getStats` | Redis | Full SCAN for key count | `DBSIZE` / `INFO keyspace` would count without enumerating |
| R20 | Dashboard | Mongo Device | Ownership findOne every request | No TTL |
| R21 | `Device.find()` / `DeviceOtaState.find({})` | Mongo | Full collection | Fleet helpers |

---

## 10. Worked cost: one reconnect vs startup of N devices

### 10.1 One existing-device `/active` (mTLS on, caches cold, IG+GMB, Redis up)

**Blocking (before handler returns):**

- Mongo: 1 cert + 2–3 Device + 1 Social Instagram  
- Redis: 1 HSET hash + 1 SADD set  

**Background / deferred (same reconnect):**

- Mongo: 1 DeviceOtaState + Social.find + Profile + Location + Device + Business + GMB 4-hop again + OTA Device/OtaState/FirmwareRelease  
- Redis: priority ZSET RMW + ota HGETALL + IG Lua  
- Influx: 1 optional 10-year latest-state query + 3 writes  

Order-of-magnitude: **~8–15 Mongo round-trips**, **~5–8 Redis commands**, **0–1 heavy Flux + writes**, per reconnect, cold caches.

Warm L1 integration cache and in-memory device-state chain: Mongo on the deferred GMB path still **re-walks** `resolveGmbContextForDevice` (R6). Loyalty idle still hits Device+Business (R3).

### 10.2 Startup with N members in `proof.mqtt:active:devices`

Let **H** = members not in local file cache, **A** = all locally active after merge.

- 1 SMEMBERS  
- 1 SCAN of all `proof.mqtt:device:*` (migration)  
- **H** × (Device findOne + Social Instagram + HSET)  
- **A** × (HGETALL + GMB 4-hop + optional integrations rebuild + Device + Business loyalty)  
- Phase 2: 1 × Q9 (`-3650d` group), 1 × Q14, 1 × Q17 unbounded, health 3 HTTP  

Linear in **A** for Mongo GMB+loyalty; Redis SCAN linear in **total device keys**, not just active.

---

## 11. Caches that already exist (so origin hits are misses or bypasses)

| Cache | Lifetime | Survives process restart? | Bypassed by |
|-------|----------|---------------------------|-------------|
| Local active device file | Process + disk | Yes (file) | Hydrate still Mongo for Redis-only members |
| IgDeviceRuntime L1 | Process memory | No | `/active` writes hash but does not go through `resolveWithCache` |
| Redis device HASH | TTL `DEVICE_HASH_TTL_SEC` | Yes | `cacheActiveDevice` overwrites; does not read first |
| User integrations L1 | 24h in-process | **No** | Every post-restart connect/rebuild |
| GMB review STRING | Redis | Yes | Republish still Mongo-resolves location first |
| Influx dashboard cache | 15–120s memory | No | N/A to connect |
| Device cert | **None** | — | Every lifecycle message |
| DeviceStateLog chains | Process memory | No | Q9 reload on start; Q8 on unknown device |
| PKI audit / CT leaves | Process memory | No | Full Influx read on start |

`/active` **does not consult** Redis device hash before Mongo `cacheActiveDevice`. Redis is written after Mongo. On reconnect the origin of truth for the hash is Mongo, not the hash left from the previous session.

---

## 12. Discussion agenda for DB architect

Facts above; options below are **questions**, not a recommended patch set.

1. **Request-scoped device document** — On `/active`, one `Device.findOne` (or the `updateOne` returning the doc) should be enough for cache, `businessId`, loyalty name lookup, and deferred GMB. What is the intended source of truth: Mongo Device, Redis hash, or local file?

2. **Cert lookup** — Active cert is a slowly changing row. Is a Redis hash field / local TTL acceptable for MQTT gate vs HTTP mTLS? What is the revocation SLA?

3. **Integrations** — 24h L1 with no Redis means every rolling restart thunders Mongo `Social` + GMB collections. Should `user:integrations:{businessId}` live on the same Redis as device hashes?

4. **GMB join** — Four round-trips vs one aggregation or a denormalized `{ locationId, verifiedReviewCount, rating }` on the device hash. Who owns freshness: webhook vs connect pull vs Mongo snapshot?

5. **Startup SMEMBERS + per-id hydrate** — For large N, SSCAN + pipelined HGETALL (skip Mongo if hash is complete) vs current Mongo hydrate. How stale may a screen be after server restart?

6. **`migrateDeviceKeysToHash` every boot** — Migration SCAN vs a one-shot flag key. Is STRING→HASH still needed in production?

7. **Influx `-3650d` / `range(0)`** — Latest-point queries vs a Redis/Mongo copy of `{sequence, hash}` (code already TODOs Redis for multi-instance in `deviceStateLogService.ts:25`). CT/OTA leaf reload: snapshot vs full scan.

8. **Loyalty idle on connect** — Needs only `business.name`. Device+Business on every `/active` and every startup device: store `business_name` on the device hash at allocation time?

9. **Connect-time Graph/GBP** — Deferred `requestImmediateFetch` and `syncGmbLocationForDevice` (external APIs + Mongo). Architect vs product: is reconnect allowed to use Redis last-known only (startup republish already does this for IG followers)?

10. **Indexes** (confirm in Atlas, not inferred from code):  
    - `Device.clientId` unique  
    - `DeviceCertificate.device_id` + status + expires_at  
    - `Social.businessId + provider`  
    - `GoogleBusinessProfile.socialId`  
    - `GoogleBusinessLocation.profileId`  
    - `DeviceOtaState.deviceId`  
    - `LoyaltySpin.sessionId + status`, `LoyaltySession.status + createdAt`

11. **Baselines to bring to the meeting** (not currently emitted as a single dashboard):  
    - p50/p95 duration of `handleDeviceRegistration`  
    - Mongo `findOne` count per `/active` (debug spans already exist as `LIFECYCLE:CACHE` logs)  
    - Flux duration of Q9 vs device_state_log cardinality  
    - Redis SCAN duration / key count at boot  
    - Size of `proof.mqtt:active:devices`  
    - Reconnect storm: devices `/active` per second after broker blip  

12. **Out of scope for “connect fetch” but same budget:** dashboard uncached Influx routes, `Device.find()` all-devices, OTA admin N+1, Redis `getStats` SCAN.

---

## 13. Sequence diagrams (logical)

### 13.1 `/active` existing device

```
Device --MQTT /active--> Ingress
  |  Mongo DeviceCertificate.findOne          [gate]
  |  Mongo Device.findOne                     [getDevice]
  |  Mongo Device.updateOne                   [fw / lastSeen]
  |  Mongo Device.findOne                     [cacheActiveDevice] REPEAT
  |  Mongo Social.findOne INSTAGRAM
  |  Redis HSET device hash
  |  Redis SADD active set
  |  Mongo Device.findOne businessId          REPEAT
  |-- fire: OtaState.findOne, Influx writes, Social.find+GMB, Device+Business loyalty
  |-- defer: integrations get, IG ZSET+fetch, GMB 4-hop, OTA finds
```

### 13.2 Startup restore

```
start Phase 1: Mongo connect, Redis connect
  SCAN proof.mqtt:device:*                    [migration]
  ingress ready
  SMEMBERS active:devices
  for missing local: Device.findOne + Social + HSET
  for each active: HGETALL; GMB 4-hop; Device+Business loyalty; MQTT retain
  Phase 2 (async): Influx health, Q9 -3650d, Q14, Q17 unbounded, poller, HTTP
```

---

## 14. File index (connect / startup)

| File | Role on these paths |
|------|---------------------|
| `src/app.ts` | `start()`, Redis active mark, Instagram Social helper, restore |
| `src/bootstrap/deviceRegistrationHandler.ts` | `/active` handler, `cacheActiveDevice` |
| `src/bootstrap/serviceInitializer.ts` | Phase 2 Influx/PKI/poller/HTTP |
| `src/bootstrap/otaRegistrationCoordinator.ts` | Deferred OTA Mongo |
| `src/services/deviceService.ts` | `getDevice` / `registerDevice` (comment on unwanted calls) |
| `src/services/connectRefreshCoordinator.ts` | Deferred IG + GMB |
| `src/services/startupCacheRepublish.ts` | SMEMBERS + per-device republish |
| `src/services/userIntegrationCache.ts` | Social + GMB location Mongo, 24h L1 |
| `src/services/igDeviceRuntimeCache.ts` | Hash I/O, SCAN migration, L3 Mongo |
| `src/services/publishLoyaltyIdle.ts` | Device + Business on connect/startup |
| `src/lib/socials/resolveDeviceGmb.ts` | 4-hop GMB |
| `src/lib/socials/syncDeviceGmb.ts` | Miss path: more Mongo + GBP API |
| `src/services/deviceProvisioningGate.ts` | Cert findOne |
| `src/services/caService.ts` | `findActiveCertificateByDeviceId` |
| `src/services/deviceStateLogService.ts` | Q8/Q9 + writes |
| `src/services/influxService.ts` | Flux definitions, health HTTP |
| `src/services/redisService.ts` | `getStats` SCAN |
| `src/services/loyaltyService.ts` | Sweeps (not `/active`, same Mongo budget) |
| `src/middleware/mtlsAuth.ts` | Duplicate cert findOne on HTTP |

---

## 15. What this audit does not include

- Production query plans / Atlas profiler output (not run in this pass).  
- Measured p95 latencies (code paths only).  
- Security review of tokens stored in Redis hashes.  
- Implementation work or patches.

---

**Report completed:** 11 September 2026  
**Stores:** MongoDB (Mongoose), Redis (node-redis), InfluxDB 2.x Flux  
**Primary symptom under review:** extra origin reads on device app connection and process start.
