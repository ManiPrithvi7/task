# ProofMQTT Redis Usage

## Overview

Redis serves as a **multi-purpose caching and distributed coordination layer** in ProofMQTT. It reduces MongoDB load, enables rate limiting, deduplication, distributed locks, and real-time device state tracking. The system uses the official [`redis`](https://www.npmjs.com/package/redis) package (node-redis) v4.7.1 — not `ioredis`.

**Three major roles:**

1. **Caching layer** — Campaigns, brand canvases, user integrations, GMB review counts, daily POS metrics
2. **Rate limiting & deduplication** — CSR submissions, OTA checks, webhook events, MQTT publish dedupe, device connect debounce
3. **Distributed coordination** — OTA release state (active/pending/delivered), Instagram polling priority queue + circuit breaker, scheduler locks, device active set, recovery sessions, stimulation locks

---

## Architecture

```
┌──────────────────┐     ┌──────────────────────────┐
│   App Services   │────>│   RedisService (singleton)  │
│  (20+ consumers) │     │   wraps RedisClientType     │
└──────────────────┘     └───────────┬──────────────┘
                                      │
                                      ▼
                            ┌──────────────────┐
                            │   redis (v4.7.1)  │
                            │   node-redis      │
                            └──────────┬───────┘
                                       │
                                       ▼
                            ┌──────────────────┐
                            │  Cloud Redis     │
                            │  (Upstash/Redis  │
                            │   Cloud)         │
                            └──────────────────┘
```

Every consumer accesses Redis via the singleton `getRedisService()` or receives a `RedisClientType` reference (via dependency injection in OTA, recovery, etc.).

---

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | — | Required. Must start with `rediss://` (TLS). Example: `rediss://default:...@host:6379` |
| `REDIS_DB` | `0` | Redis database number |
| `REDIS_KEY_PREFIX` | `proof-mqtt:` | Key prefix for all namespaced keys |

```typescript
// src/config/index.ts — RedisConfig interface
interface RedisConfig {
  enabled: boolean;
  url?: string;
  db?: number;
  keyPrefix?: string;
}
```

**Validation:** In `validateConfig()`, if `REDIS_URL` is missing, Redis is disabled with a warning. If present, it must use `rediss://` (TLS). A warning is logged if the host doesn't contain `upstash.io`.

---

## Core Component: RedisService

**File:** `src/services/redisService.ts`

A singleton class that wraps `RedisClientType` from `node-redis`.

### Constructor
```typescript
class RedisService {
  constructor(config: RedisConfig)
  private client: RedisClientType | null
  private isConnected: boolean
  private commandCount: number
  private commandCountByType: Map<string, number>
}
```

### Key Methods

| Method | Description |
|---|---|
| `connect()` | Create client with `createClient()`, exponential-backoff reconnect (max 20 retries, 15s cap), TLS for `rediss://`, wraps `sendCommand` to track per-type counters |
| `disconnect()` | Graceful `client.quit()` if `isOpen` |
| `getClient()` | Returns `RedisClientType` or throws if not initialized |
| `isRedisConnected()` | Returns `isConnected && client.isOpen` |
| `isRedisConfigured()` | Returns whether `url` is set and non-empty |
| `healthCheck()` | `PING` → expects `PONG` |
| `getStats()` | `SCAN` keys + `INFO memory` (avoid on hot paths / health) |
| `getCommandStats()` | Returns `{ total, byType }` in-process counters (command names only) |
| `getStatsSince()` | ISO timestamp when this `RedisService` instance was constructed |

Internal `/health` (loopback or `x-internal-health`) includes:

```json
"redis": {
  "connected": true,
  "since": "2026-07-29T15:00:00.000Z",
  "commands": { "total": N, "byType": { "EVALSHA": ..., "SMISMEMBER": ... } }
}
```

Uses `getCommandStats()` only — never `getStats()` SCAN on health.

### Reconnect Strategy
```typescript
const delayMs = Math.min(1000 * 2^retries, 15000) + random(0-250)ms
```
Max 20 retries; after exhaustion throws `Error('Redis reconnect attempts exhausted')`.

### Socket Options
- `connectTimeout`: 10,000ms
- `keepAlive`: 5,000ms
- `noDelay`: true

### Event Handlers
| Event | Action |
|---|---|
| `connect` | Log info |
| `ready` | Set `isConnected = true` |
| `end` | Set `isConnected = false` |
| `reconnecting` | Log info |
| `error` | Log error, set `isConnected = false` |

### Singleton Accessors
```typescript
export function createRedisService(config: RedisConfig): RedisService  // creates + sets singleton
export function getRedisService(): RedisService | null                 // returns existing singleton
```

---

## Redis Key Namespaces

### Core Namespace (configurable prefix, default `proof-mqtt:`)

| Key Pattern | Type | Purpose | TTL | Source File |
|---|---|---|---|---|
| `{prefix}ota:active_release` | String (JSON) | Current active OTA release | 30d | `otaService.ts` |
| `{prefix}ota:previous_active_release` | String (JSON) | Previous active release (for rollback) | 30d | `otaService.ts` |
| `{prefix}ota:pending:{version}` | Set | Device IDs pending update for a version | 30d | `otaService.ts` |
| `{prefix}ota:delivered:{version}` | Set | Device IDs that received update | 30d | `otaService.ts` |
| `{prefix}ota:stage:{version}:{pct}:attempted` | Set | Devices that attempted a rollout stage | 30d | `otaService.ts` |
| `{prefix}ota:deferred:{deviceId}` | String | Catchup deferral rate limit (NX) | 1d | `otaService.ts` |
| `{prefix}ota:scheduler:lock` | String | Rollout scheduler distributed lock | Configurable (NX) | `otaService.ts` |
| `{prefix}ota:scheduler:last_run` | String (ISO date) | Last scheduler run timestamp | None (persistent) | `otaService.ts` |
| `{prefix}ota:check:{deviceId}` | String | OTA check rate limit (NX) | Configurable | `otaRoutes.ts` |
| `{prefix}recovery:session:{deviceId}` | String (JSON) | Factory-reset recovery session | 15min | `recoverySessionService.ts` |

### Hardcoded Keys (no prefix)

| Key Pattern | Type | Purpose | TTL | Source |
|---|---|---|---|---|
| `proof.mqtt:active:devices` | Set | Active device IDs (startup recovery) | 7d | `app.ts` |
| `proof.mqtt:device:{deviceId}` | String (JSON) | Device Instagram credentials | 7d | `app.ts` |
| `priority_zset` | ZSet | Instagram priority polling queue | Lua-managed | `instagramService.ts` |
| `instagram:circuit:blocked_until` | String (timestamp) | Instagram circuit breaker open state | Configurable | `instagramService.ts` |
| `instagram:pending:{deviceId}` | String | Instagram pending fetch flag | None | `app.ts` |

### Cache Keys (no prefix)

| Key Pattern | Type | Purpose | TTL | Source |
|---|---|---|---|---|
| `promo:active:{userId}` | String (JSON) | Cached eligible campaigns | 1h | `promotionService.ts` |
| `promo:rotation:{deviceId}` | String (number) | Round-robin rotation index | 1h | `promotionService.ts` |
| `canvas:active:{userId}` | String (JSON) | Cached brand canvas ad | 1h | `brandCanvasService.ts` |
| `user:integrations:{userId}` | String (JSON) | Cached user integrations | 1d | `userIntegrationCache.ts` |
| `msg:last_hash:{deviceId}:{topic}` | String (md5) | MQTT publish dedupe hash | 1d | `mqttChangeDetection.ts` |
| `device:followers:{deviceId}` | String (number) | IG follower count | None | `instagramService.ts` |
| `device:fetch_history:{deviceId}` | ZSet | IG fetch backoff history | Lua-managed | `instagramService.ts` |
| `device:connect_refresh:{deviceId}` | String | Connect refresh debounce (NX) | 30s | `connectRefreshCoordinator.ts` |
| `ig:power_save:{deviceId}` | String | IG power-save flag | 1d | `app.ts`, `instagramService.ts` |
| `ig:bg:fair_offset` | String (number) | Background polling fair cursor | None | `instagramService.ts` |
| `ig:last_pub:{deviceId}` | String (timestamp) | IG last publish timestamp | 1d | `startupCacheRepublish.ts` |
| `gmb:reviews:{locationId}` | String (number) | GMB review count cache | 30d | `gmbReviewCache.ts` |
| `webhook:dedupe:{dedupeKey}` | String | Webhook event deduplication (NX) | 1d | `redisDedupe.ts` |

### Rate Limit Keys (no prefix)

| Key Pattern | Type | Purpose | TTL | Source |
|---|---|---|---|---|
| `csr:global:{minuteBucket}` | String (counter) | Global CSR rate limit | 60s | `csrRateLimiter.ts` |
| `csr:ip:{clientIp}` | String (counter) | Per-IP CSR rate limit | 15min | `csrRateLimiter.ts` |
| `csr:provisioned:{deviceId}` | String (counter) | Per-device CSR rate limit | 15min | `csrRateLimiter.ts` |
| `csr:unprovisioned:{clientIp}` | String (counter) | Per-unprovisioned CSR rate limit | 15min | `csrRateLimiter.ts` |

### Daily Metrics Keys (no prefix)

| Key Pattern | Type | Purpose | TTL | Source |
|---|---|---|---|---|
| `metrics:orders:{userId}:{dateKey}:set` | Set | Checkout ID dedupe set | Until midnight | `processDailyMetrics.ts` |
| `metrics:orders:{userId}:{dateKey}:count` | String (counter) | Daily order count | Until midnight | `processDailyMetrics.ts` |
| `metrics:orders:{userId}:{dateKey}:revenue_cents` | String (counter) | Daily revenue in cents | Until midnight | `processDailyMetrics.ts` |
| `metrics:orders:{userId}:{dateKey}:last` | String (JSON) | Last order JSON | Until midnight | `processDailyMetrics.ts` |
| `cache:pos:daily:{userId}:{dateKey}` | String | POS daily cache | 5min | `metrics/helpers.ts` |
| `cache:pos:daily:{userId}:{dateKey}:top_seller` | String | POS daily top seller | 5min | `metrics/helpers.ts` |

### Stimulate Locks (testing only)

| Key | TTL | Source |
|---|---|---|
| `stim:ig:lock:{deviceId}` | `STIM_IG_LOCK_TTL_SEC` | `stimulate/igRunner.ts` |
| `stim:gmb:lock:{deviceId}` | `STIM_GMB_LOCK_TTL_SEC` | `stimulate/gmbRunner.ts` |

---

## Domain Components

### 1. OtaRedisState — OTA Coordination

**File:** `src/services/otaService.ts`

Manages OTA firmware release state atomically in Redis. Used by `OtaService`, `OtaEventHandler`, and the rollout scheduler.

```typescript
class OtaRedisState {
  constructor(
    private readonly prefix: string,
    private readonly getClient: () => RedisClientType | null
  )
}
```

**Methods (20+):**

| Method | Redis Command | Purpose |
|---|---|---|
| `setActiveRelease(release)` | `SET {prefix}ota:active_release` | Store current active release |
| `getActiveRelease()` | `GET {prefix}ota:active_release` | Get current active release |
| `clearActiveRelease()` | `DEL {prefix}ota:active_release` | Clear on rollback |
| `forceSetActiveRelease(release)` | `SET {prefix}ota:previous_active_release` | Force set as previous |
| `getPreviousActiveRelease()` | `GET {prefix}ota:previous_active_release` | Get previous for rollback |
| `seedPendingFleet(version, deviceIds[])` | `SADD {prefix}ota:pending:{version}` | Bulk add pending devices |
| `addPendingDevices(version, deviceIds[])` | `SADD {prefix}ota:pending:{version}` | Add more pending |
| `clearPendingFleet(version)` | `DEL {prefix}ota:pending:{version}` | Clear pending set |
| `isPending(deviceId, version)` | `SISMEMBER {prefix}ota:pending:{version}` | Check if device is pending (`true` if Redis unavailable) |
| `filterPending(version, deviceIds[])` | Chunked `SMISMEMBER` via `smIsMember` (500) / fallback `SISMEMBER` | Batch pending filter for fleet push; `!client` → return all IDs (same as `isPending`) |
| `markPending(deviceId, version)` | `MULTI` `SADD`+`EXPIRE` | Mark a device pending |
| `isDelivered(deviceId, version)` | `SISMEMBER {prefix}ota:delivered:{version}` | Check if device got update |
| `markDelivered(deviceId, version)` | `MULTI` `SREM`+`SADD`+`EXPIRE` | Mark device as updated |
| `markStageAttempted(version, pct, deviceId)` | `MULTI` `SADD`+`EXPIRE` | Track stage attempt |
| `clearStageAttempted(version, pct)` | `DEL {prefix}ota:stage:{v}:{pct}:attempted` | Clear stage tracking |
| `tryAcquireSchedulerLock()` | `SET {prefix}ota:scheduler:lock NX EX <ttl>` | Acquire distributed lock |
| `releaseSchedulerLock()` | `DEL {prefix}ota:scheduler:lock` | Release scheduler lock |
| `shouldLogCatchupDeferred(deviceId)` | `SET {prefix}ota:deferred:{id} NX EX 86400` | Rate-limit catchup logging |
| `isVersionDeliveredToAll(version, count)` | `SCARD {prefix}ota:delivered:{version}` | Check if fully delivered |

**Graceful degradation:** All methods guard with `if (!client) return null/false/true` — no crash when Redis is unavailable.

---

### 2. Instagram Polling & Lua Scripts

**File:** `src/services/instagramService.ts`

The Instagram poller uses Redis for **dual-scheduler coordination** (priority + background), **circuit breaker**, **fetch backoff**, **global fetch budget**, and **fair rotation**.

#### Redis Keys
```typescript
REDIS_KEYS = {
  priorityZset: 'priority_zset',
  circuitBlockedUntil: 'instagram:circuit:blocked_until',
  deviceFollowers: (id) => `device:followers:${id}`,
  deviceFetchHistory: (id) => `device:fetch_history:${id}`,
  igPowerSave: (id) => `ig:power_save:${id}`,
  backgroundFairnessOffset: 'ig:bg:fair_offset'
}
```

#### Lua Scripts (4 total)

**A. `atomicPriorityReadAndPruneLua`**
```lua
local active = redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], '+inf')
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
return active
```
- Atomically read priority entries with score > `nowMs` then prune expired ones
- Keys: `priority_zset`

**B. `atomicBackoffCheckAndRecordLua`**
```lua
local key = KEYS[1]
local now = tonumber(ARGV[1])
local uuid = ARGV[2]
local threshold = tonumber(ARGV[3])
local window = tonumber(ARGV[4])
local start = now - window
redis.call('ZREMRANGEBYSCORE', key, '-inf', start)
local count = redis.call('ZCOUNT', key, start, now)
if count >= threshold then return 0 end
redis.call('ZADD', key, now, uuid)
redis.call('EXPIRE', key, math.ceil(window/1000) + 1)
return 1
```
- Sliding-window backoff: prune old entries, count recent, add if under threshold
- Keys: `device:fetch_history:{deviceId}`

**C. `atomicFetchBudgetTryLua`**
```lua
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], 120) end
local lim = tonumber(ARGV[1])
if lim <= 0 then return 1 end
if c > lim then redis.call('DECR', KEYS[1]); return 0 end
return 1
```
- Global per-minute fetch budget: atomic INCR + EXPIRE + DECR if over limit

**D. `DAILY_METRICS_LUA`** (in `src/services/metrics/dailyMetricsLua.ts`)
- 4 keys: `setKey`, `countKey`, `revenueCentsKey`, `lastKey`
- SADD for deduplication, INCR/INCRBY for counters, SET for last order
- EXPIRE on all keys to TTL until midnight

#### Lua Loading Pattern
```typescript
// SCRIPT LOAD + EVALSHA with EVAL fallback
async function loadInstagramPollingScripts(redis: RedisClientType, force?: boolean): Promise<void>
async function evalShaWithFallback(redis: RedisClientType, sha: string, lua: string, opts: EvalOptions): Promise<unknown>
```

---

### 3. RecoverySessionService — Factory Reset Sessions

**File:** `src/services/recoverySessionService.ts`

```typescript
class RecoverySessionService {
  constructor(private readonly sessionTtlSec: number)
}
```

| Method | Redis Command | Purpose |
|---|---|---|
| `registerSession(deviceId, payload)` | `SET {prefix}recovery:session:{id} EX <ttl>` | Create recovery session |
| `verifySession(deviceId, token)` | `GET {prefix}recovery:session:{id}` + compare hash | Verify + rate-limit |
| `consumeSession(deviceId)` | `DEL {prefix}recovery:session:{id}` | Single-use consume |
| `isAvailable()` | Check `getRedis()` !== null | Health check |

Key: `{prefix}recovery:session:{deviceId}`, TTL: 900s (15min, configurable via `RECOVERY_SESSION_TTL_SEC`).

---

### 4. PromotionService — Campaign Cache

**File:** `src/services/promotionService.ts`

Caches eligible campaigns per user and tracks round-robin rotation index per device.

| Function | Redis Key | TTL |
|---|---|---|
| `getEligibleCampaignsForUser(userId)` | `promo:active:{userId}` | 3600s (1h) |
| `getNextPromotionIndex(deviceId, total)` | `promo:rotation:{deviceId}` | 3600s (1h) |
| `invalidatePromotionCache(userId)` | DEL `promo:active:{userId}` | — |
| `resetRotationForUser(userId)` | DEL `promo:rotation:*` | — |

Fallback: MongoDB query when Redis unavailable.

---

### 5. BrandCanvasService — Ad Cache

**File:** `src/services/brandCanvasService.ts`

| Function | Redis Key | TTL |
|---|---|---|
| `getCachedBrandCanvasAd(userId)` | `canvas:active:{userId}` | 3600s (1h) |
| `invalidateCanvasCache(userId)` | DEL `canvas:active:{userId}` | — |

---

### 6. UserIntegrationCache — Social Integrations

**File:** `src/services/userIntegrationCache.ts`

| Function | Redis Key | TTL |
|---|---|---|
| `getUserIntegrations(userId)` | `user:integrations:{userId}` | 86400s (1d) |
| `cacheUserIntegrations(userId, data)` | `SET ... EX 86400` | 1d |
| `invalidateUserIntegrations(userId)` | DEL `user:integrations:{userId}` | — |

Caches Instagram/GMB/POS connection status per user.

---

### 7. MQTT Change Detection — Publish Deduplication

**File:** `src/services/mqttChangeDetection.ts`

```typescript
// Key: msg:last_hash:{deviceId}:{topic}
// Value: md5 hash of stable-JSON serialized payload

publishIfChanged({ deviceId, topic, hashInput, payload, mqttClient }) 
  → { published: boolean, reason: 'changed' | 'unchanged' | 'no_redis' }

publishForce({ deviceId, topic, hashInput, payload, mqttClient })
  → void

clearPublishHash(deviceId, topic) → boolean
clearAllPublishHashesForDevice(deviceId) → number  // SCAN + DEL pattern
```

TTL: 86400s (1d). No Redis fallback: always publishes (no dedupe protection).

---

### 8. Webhook Deduplication

**File:** `src/webhooks/dedupe/redisDedupe.ts`

```typescript
tryClaimWebhookDedupe(dedupeKey: string): Promise<boolean>
// Uses: SET webhook:dedupe:{key} NX EX 86400
// Returns: true if this is the first claim (NX succeeded)
```

Fallback: Processes without deduplication (logs warning).

---

### 9. CSR Rate Limiter

**Files:** `src/middleware/csrRateLimiter.ts`, `src/middleware/csrRateLimitLua.ts`

```typescript
csrRateLimiter(config?) → Express middleware
```

**When Redis connected:** one short-circuit Lua `EVALSHA` per request (`csrRateLimitLua v1`).

| KEYS / ARGV | Meaning |
|---|---|
| KEYS[1–3] | `csr:global:{minuteBucket}`, `csr:ip:{ip}`, provisioned or unprovisioned key |
| ARGV[1–3] | globalLimit, ipLimit, deviceLimit |
| ARGV[4–6] | windows (60, windowSeconds, windowSeconds) |
| Return | `{ allowed, retryAfter, limitType, count, limit }` — `limitType` `device` mapped to `per_device` \| `unprovisioned` in TS |

Short-circuit: if global exceeds, IP/device keys are **not** incremented. Lua timeout / SCRIPT KILL → **fail open** (no sequential Redis re-INCR). Redis absent → local Map short-circuit (enforces limits in-process).

| Counter Key | Window |
|---|---|
| `csr:global:{minuteBucket}` | 60s |
| `csr:ip:{clientIp}` | 900s |
| `csr:provisioned:{deviceId}` | 900s |
| `csr:unprovisioned:{clientIp}` | 900s |

---

### 10. Daily Metrics — POS Order Tracking

**Files:** `src/services/metrics/dailyMetricsLua.ts`, `src/services/metrics/processDailyMetrics.ts`

```typescript
processDailyMetrics(input: { userId, checkoutId, revenueCents, ... })
// Uses EVALSHA of DAILY_METRICS_LUA with 4 keys + 4 args
```

Lua script atomically:
1. SADD checkoutId to set (dedupe)
2. INCR order count, INCRBY revenue
3. SET last order JSON
4. EXPIRE all keys to midnight TTL

---

### 11. Connect Refresh Coordinator

**File:** `src/services/connectRefreshCoordinator.ts`

```typescript
class ConnectRefreshCoordinator {
  async refresh(deviceId): Promise<boolean>
  // Uses: SET device:connect_refresh:{deviceId} NX EX 30
  // Debounces connect refresh calls to 30s intervals
}
```

---

### 12. GMB Review Cache

**File:** `src/webhooks/gmbReviewCache.ts`

```typescript
getGmbReviewCount(locationId: string): Promise<number | null>
// GET gmb:reviews:{locationId}

setGmbReviewCount(locationId: string, count: number): Promise<void>
// SET gmb:reviews:{locationId} EX 2592000 (30d)
```

---

## Active Device Management

Handled inline in `src/app.ts` (not in a dedicated service):

```typescript
// On device /active message:
redisMarkDeviceActive(deviceId): 
  MULTI
    SADD proof.mqtt:active:devices <deviceId>
    EXPIRE proof.mqtt:active:devices 604800  // 7d
  EXEC

// On LWT disconnect:
redisRemoveDevice(deviceId):
  MULTI
    SREM proof.mqtt:active:devices <deviceId>
    DEL proof.mqtt:device:<deviceId>
  EXEC
```

The `proof.mqtt:device:{deviceId}` key stores the device's Instagram credentials (accountId, accessToken, tokenExpiresAt) synced from MongoDB.

---

## Startup Cache Recovery

**File:** `src/services/startupCacheRepublish.ts`

On process restart, Redis is used to recover state:

```typescript
// 1. Recover active devices from Redis set
restoreActiveDevicesFromRedis(redisClient, hydrateFn):
  SMEMBERS proof.mqtt:active:devices
  → For each member not in local cache, hydrate from MongoDB

// 2. Republish cached screens for active devices
republishCachedScreensForActiveDevices(mqttClient, topicRoot, ...):
  For each locally active device:
    GET device:followers:{deviceId}  → republish IG screen
    GET ig:last_pub:{deviceId}       → check if recently published
    Search for GMB location cache    → republish GMB screen
```

---

## Graceful Degradation

Every Redis consumer follows a "fail open" pattern. When Redis is unavailable:

| Service | Behavior |
|---|---|
| **OtaRedisState** | All methods return null/false/true — operations skip silently |
| **RecoverySessionService** | Returns `REDIS_UNAVAILABLE` error; `isAvailable()` returns false |
| **CSR Rate Limiter** | Local Map when Redis absent; fail open if Lua errors while Redis connected |
| **OtaRedisState.filterPending** | Redis absent → all device IDs treated as pending (parity with `isPending`) |
| **Promotion Service** | Reads from MongoDB directly; rotation defaults to index 0 |
| **Brand Canvas** | Falls through to MongoDB query |
| **User Integration Cache** | Falls through to MongoDB query |
| **MQTT Change Detection** | Always publishes (no dedupe); `clearAllPublishHashesForDevice` returns 0 |
| **Webhook Dedupe** | Processes without deduplication (logs warning) |
| **Instagram Poller** | Disables itself at startup — "Instagram poller disabled (Redis not connected)" |
| **Stimulate Service** | Skips Redis lock operations |
| **Connect Refresh** | Debounce returns false (proceeds without debounce) |
| **Daily Metrics** | Skips recording (logs warning) |
| **GMB Review Cache** | Returns null for reads; skips writes |
| **Active Device Mgmt** | `getRedisClientOrNull()` returns null; device active set / meta keys skip silently |
| **Startup Cache** | `restoreActiveDevicesFromRedis` returns `{0, 0}`; IG/GMB republish skips |

**General philosophy: Redis is a performance/cache layer — the system degrades gracefully to MongoDB or in-memory fallbacks when Redis is down.**

---

## TTL Reference

| Value | Usage |
|---|---|
| 30s | Connect refresh debounce |
| 60s | Global CSR rate limit window |
| 120s | IG fetch budget counter expiry |
| 300s (5min) | POS daily cache |
| 600s (10min) | OTA pilot download rate limit (in-memory) |
| 900s (15min) | Per-IP/per-device CSR rate limit, recovery session TTL |
| 3600s (1h) | Campaign ad cache, brand canvas cache, promo rotation |
| 86400s (1d) | MQTT dedupe hash, webhook dedupe, OTA catchup deferral, IG power_save, IG last_pub, user integrations cache |
| 604800s (7d) | Active device set, device meta key |
| 2592000s (30d) | OTA release data, pending/delivered/stage sets, GMB review count |
| Dynamic (midnight) | Daily metrics keys (seconds until midnight in configured timezone) |
| Dynamic (Lua) | IG priority zset (pruned by score), backoff history (window-based) |

**Atomic patterns used:**
- `NX + EX`: Set if not exists + TTL — rate limits, debounce, dedupe, locks
- `INCR + EXPIRE`: Counter with TTL on first increment only
- `SET + EX`: Simple key-value with expiry
- `SET + KEEPTTL`: Modify value preserving existing TTL (recovery session verification attempts)
- `EXPIRE` on Sets/ZSets: Post-add TTL for collection keys
- `MULTI/EXEC`: Transactional batches (active device management)

---

## Files Using Redis

| File | Role |
|---|---|
| `src/services/redisService.ts` | Core singleton service |
| `src/services/otaService.ts` | `OtaRedisState` — OTA release coordination |
| `src/services/recoverySessionService.ts` | Factory-reset recovery sessions |
| `src/services/promotionService.ts` | Campaign cache + rotation index |
| `src/services/brandCanvasService.ts` | Brand canvas ad cache |
| `src/services/instagramService.ts` | IG polling (Lua atomics, circuit breaker, priority, backoff, budget) |
| `src/services/userIntegrationCache.ts` | User social integrations cache |
| `src/services/mqttChangeDetection.ts` | MQTT publish deduplication |
| `src/services/startupCacheRepublish.ts` | Active device recovery + IG/GMB cache republish |
| `src/services/stimulateService.ts` | Staging stimulation locks |
| `src/services/connectRefreshCoordinator.ts` | Connect refresh debounce |
| `src/services/metrics/dailyMetricsLua.ts` | Daily metrics Lua script |
| `src/services/metrics/processDailyMetrics.ts` | Daily metrics execution |
| `src/services/deviceService.ts` | Active device cache (local file, Redis path commented) |
| `src/middleware/csrRateLimiter.ts` | CSR rate limiting (Lua EVALSHA when Redis up) |
| `src/middleware/csrRateLimitLua.ts` | CSR short-circuit Lua script + EVALSHA helpers |
| `src/webhooks/dedupe/redisDedupe.ts` | Webhook deduplication |
| `src/webhooks/gmbReviewCache.ts` | GMB review count cache |
| `src/app.ts` | Redis init, active device set, device meta keys |
| `src/routes/otaRoutes.ts` | OTA check rate limiter |
| `src/routes/webhookRoutes.ts` | Webhook health probe |
| `src/config/index.ts` | Redis config definition |
| `src/lib/socials/instagramTokenRefresh.ts` | Device meta key for token refresh |

---

## Dependency

```
"redis": "^4.7.1"
```

The official `node-redis` package. Used via `import { createClient, RedisClientType } from 'redis'`.

---

## Test Coverage

| Test File | Coverage |
|---|---|
| `tests/unit/services/recoverySessionService.test.ts` | JWT parsing, registerSession (mock Redis), verifySession, rate limiting |
| `tests/unit/services/startupCacheRepublish.test.ts` | `devicesNeedingHydration()` pure function |
| `tests/unit/services/promotionService.test.ts` | Campaign caching (mocks `getRedisService`) |
| `tests/unit/services/brandCanvasService.test.ts` | Canvas caching (mocks `getRedisService`) |
| `tests/unit/services/mqttChangeDetection.test.ts` | Hash dedupe (mocks `getRedisService`) |
| `tests/unit/webhooks/dedupe/redisDedupe.test.ts` | Dedupe when Redis unavailable |
| `tests/unit/stimulate/igRunner.test.ts` | IG stimulate runner (Redis mock) |
| `tests/unit/stimulate/gmbRunner.test.ts` | GMB stimulate runner (Redis mock) |
| `tests/unit/routes/otaRoutes.test.ts` | OTA routes with `redisKeyPrefix` |
| `tests/unit/jobs/rolloutScheduler.test.ts` | OTA rollout scheduler (uses `OtaRedisState`) |

---

## Summary: Redis Key Count

| Category | # Key Patterns | Primary Purpose |
|---|---|---|
| OTA | 9 | Release state, pending/delivered tracking, scheduler locks |
| Instagram | 7 | Priority queue, circuit breaker, backoff, followers, budget |
| Rate Limiting | 4 | CSR throttling |
| Caching | 5 | Campaigns, canvases, integrations, GMB reviews, daily metrics |
| Coordination | 3 | Recovery sessions, connect debounce, webhook dedupe |
| Device State | 3 | Active devices, device meta, publish hashes |
| Stimulate (test) | 2 | IG/GMB stimulation locks |
| **Total** | **~33 distinct patterns** | |

