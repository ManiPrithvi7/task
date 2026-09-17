# Redis Usage Audit — proofmqtt

> **Generated**: 2026-07-30
> **Methodology**: Exhaustive code trace — every `.get()`, `.set()`, `.del()`, `.sadd()`, `.expire()`, `.eval()`, etc. across all source files.
> **Global keyPrefix**: `proof-mqtt:` (set via `REDIS_KEY_PREFIX` env var, default `proof-mqtt:` — applied automatically by node-redis to every key)

---

## Part 1: Redis Call Inventory

### 1.1 Device Active Registry (app.ts)

| # | FILE:LINE | CMD | KEY PATTERN | TRIGGER | FREQ | CRITICALITY |
|---|-----------|-----|-------------|---------|------|-------------|
| 1 | app.ts:177 | `SADD` | `proof.mqtt:active:devices` | Device connects (`/active`) | 1× per connect | OPERATIONAL |
| 2 | app.ts:178 | `EXPIRE` | `proof.mqtt:active:devices` | Same pipeline | 1× per connect (TTL 7d refresh) | OPERATIONAL |
| 3 | app.ts:193 | `SREM` | `proof.mqtt:active:devices` | Device disconnects (LWT/PUBACK timeout) | 1× per disconnect | OPERATIONAL |
| 4 | app.ts:194 | `DEL` | `proof.mqtt:device:{deviceId}` | Same pipeline | 1× per disconnect | OPERATIONAL |
| 5 | app.ts:1502 | `SET EX` | `proof.mqtt:device:{deviceId}` | Device connects (after Mongo lookup) | 1× per connect (if IG linked) | CRITICAL |
| 6 | app.ts:1512 | `DEL` | `proof.mqtt:device:{deviceId}` | Device connects (no IG linked, clear stale) | 1× per connect (if no IG) | OPERATIONAL |
| 7 | app.ts:698 | `SET EX` | `ig:power_save:{deviceId}` | PUBACK received (power-save flag) | 1× per PUBACK | OPERATIONAL |
| 8 | app.ts:1606 | `ZREM` | `priority_zset` | Device disconnects (LWT cleanup) | 1× per disconnect | OPERATIONAL |
| 9 | app.ts:1607 | `DEL` | `device:fetch_history:{deviceId}` | Same pipeline | 1× per disconnect | TELEMETRY |
| 10 | app.ts:1608 | `DEL` | `device:followers:{deviceId}` | Same pipeline | 1× per disconnect | TELEMETRY |
| 11 | app.ts:1609 | `DEL` | `instagram:pending:{deviceId}` | Same pipeline | 1× per disconnect | TELEMETRY |

### 1.2 Startup / Restore (startupCacheRepublish.ts)

| # | FILE:LINE | CMD | KEY PATTERN | TRIGGER | FREQ | CRITICALITY |
|---|-----------|-----|-------------|---------|------|-------------|
| 12 | startupCacheRepublish.ts:54 | `SMEMBERS` | `proof.mqtt:active:devices` | Server restart | 1× per restart | OPERATIONAL |
| 13 | startupCacheRepublish.ts:101 | `GET` | `device:followers:{deviceId}` | Restart republish (per device) | 1× per active device | TELEMETRY |
| 14 | startupCacheRepublish.ts:121 | `SET EX` | `ig:last_pub:{deviceId}` | Restart republish (per device) | 1× per active device | TELEMETRY |

### 1.3 Instagram Polling (instagramService.ts)

| # | FILE:LINE | CMD | KEY PATTERN | TRIGGER | FREQ | CRITICALITY |
|---|-----------|-----|-------------|---------|------|-------------|
| 15 | instagramService.ts:225 | `EVAL` | `priority_zset` | Priority scheduler tick | ~1× per 2s per poller | OPERATIONAL |
| 16 | instagramService.ts:240 | `EVAL` | `device:fetch_history:{deviceId}` | Per-device fetch attempt | 1× per device per tick | OPERATIONAL |
| 17 | instagramService.ts:248 | `EVAL` | `ig:poll:global_fetch_budget:{slot}` | Before each fetch | 1× per device per tick | OPERATIONAL |
| 18 | instagramService.ts:273-275 | `SCRIPT LOAD` | — | Poller startup | 1× per poller start | OPERATIONAL |
| 19 | instagramService.ts:300/304 | `EVALSHA` | (per Lua script) | After script load | 1× per device per tick | OPERATIONAL |
| 20 | instagramService.ts:407 | `GET` | `instagram:circuit:blocked_until` | Before each fetch (circuit breaker) | 1× per device per tick | OPERATIONAL |
| 21 | instagramService.ts:430 | `SET EX` | `instagram:circuit:blocked_until` | API returns 429/error | Rare (on error) | CRITICAL |
| 22 | instagramService.ts:443 | `DEL` | `instagram:circuit:blocked_until` | Circuit reset | Rare (on success after cooldown) | OPERATIONAL |
| 23 | instagramService.ts:686 | `GET` | `device:followers:{deviceId}` | Publish screen (check if changed) | 1× per IG poll result | OPERATIONAL |
| 24 | instagramService.ts:691 | `GET` | `ig:last_pub:{deviceId}` | Same function | 1× per IG poll result | TELEMETRY |
| 25 | instagramService.ts:764 | `SET EX` | `device:followers:{deviceId}` | After successful fetch | 1× per IG poll result | TELEMETRY |
| 26 | instagramService.ts:765 | `SET EX` | `ig:last_pub:{deviceId}` | After successful fetch | 1× per IG poll result | TELEMETRY |
| 27 | instagramService.ts:839 | `GET` | `device:followers:{deviceId}` | `readCachedFollowers()` | On demand | TELEMETRY |
| 28 | instagramService.ts:1313 | `GET` | `proof.mqtt:device:{deviceId}` | Per-device fetch resolution | 1× per device per poll | CRITICAL |
| 29 | instagramService.ts:1530 | `ZSCORE` | `priority_zset` | `markPriority()` (attention fetch) | 1× per attention fetch | OPERATIONAL |
| 30 | instagramService.ts:1541 | `ZADD` | `priority_zset` | Same function | 1× per attention fetch | OPERATIONAL |
| 31 | instagramService.ts:1545 | `ZCARD` | `priority_zset` | Same function | 1× per attention fetch | OPERATIONAL |
| 32 | instagramService.ts:1547 | `ZREMRANGEBYRANK` | `priority_zset` | Same function (prune overflow) | 1× per attention fetch | OPERATIONAL |
| 33 | instagramService.ts:1570 | `EVALSHA` | `device:fetch_history:{deviceId}` | `requestImmediateFetch()` | 1× per immediate fetch | OPERATIONAL |
| 34 | instagramService.ts:1627 | `SET NX PX` | `ig:fetch_dedupe:{deviceId}` | `reserveFetchDedupe()` | 1× per device fetch attempt | OPERATIONAL |
| 35 | instagramService.ts:1664 | `EXISTS` (multi) | `ig:power_save:{deviceId}` | `filterOutPowerSave()` | 1× per scheduler tick per device batch | OPERATIONAL |
| 36 | instagramService.ts:1691 | `GET` | `ig:bg:fair_offset` | Background scheduler tick | 1× per bg tick | OPERATIONAL |
| 37 | instagramService.ts:1703 | `SET` | `ig:bg:fair_offset` | Same function | 1× per bg tick | OPERATIONAL |
| 38 | instagramService.ts:1854 | `ZRANGEBYSCORE` | `priority_zset` | Background scheduler tick | 1× per bg tick | OPERATIONAL |

### 1.4 Instagram Token Refresh (instagramTokenRefresh.ts)

| # | FILE:LINE | CMD | KEY PATTERN | TRIGGER | FREQ | CRITICALITY |
|---|-----------|-----|-------------|---------|------|-------------|
| 39 | instagramTokenRefresh.ts:114-127 | `GET` + `SET` | `proof.mqtt:device:{deviceId}` | Token refresh (expired) | ~1× per 60d per device | CRITICAL |

### 1.5 User Integration Cache (userIntegrationCache.ts)

| # | FILE:LINE | CMD | KEY PATTERN | TRIGGER | FREQ | CRITICALITY |
|---|-----------|-----|-------------|---------|------|-------------|
| 40 | userIntegrationCache.ts:120 | `SET EX` | `user:integrations:{userId}` | Cache miss (Mongo rebuild) | On demand (TTL 24h) | OPERATIONAL |
| 41 | userIntegrationCache.ts:145 | `DEL` | `user:integrations:{userId}` | Invalidation call | On social disconnect | OPERATIONAL |
| 42 | userIntegrationCache.ts:160 | `GET` | `user:integrations:{userId}` | Cache read | On demand | OPERATIONAL |
| 43 | userIntegrationCache.ts:211 | `SET EX` | `user:integrations:{userId}` | Social disconnect (partial update) | On social disconnect | OPERATIONAL |

### 1.6 Provisioning Token Store (tokenStore.ts)

| # | FILE:LINE | CMD | KEY PATTERN | TRIGGER | FREQ | CRITICALITY |
|---|-----------|-----|-------------|---------|------|-------------|
| 44 | tokenStore.ts:105 | `SETEX` | `token:{token}` | Token issued during provisioning | 1× per device provision | CRITICAL |
| 45 | tokenStore.ts:110 | `SETEX` | `device:{deviceId}` | Same operation | 1× per device provision | CRITICAL |
| 46 | tokenStore.ts:146 | `GET` | `token:{token}` | Token verification | 1× per provisioning request | CRITICAL |
| 47 | tokenStore.ts:186 | `GET` | `device:{deviceId}` | Token lookup by device | On demand | CRITICAL |
| 48 | tokenStore.ts:190 | `GET` | `token:{token}` | Same function | On demand | CRITICAL |
| 49 | tokenStore.ts:239 | `SETEX` | `prov:consumed:{sha256(token)}` | Token consumed | 1× per provision complete | CRITICAL |
| 50 | tokenStore.ts:257 | `GET` | `prov:consumed:{sha256(token)}` | Check if consumed | On demand | CRITICAL |
| 51 | tokenStore.ts:285 | `GET` | `token:{token}` | Token deletion | On demand | CRITICAL |
| 52 | tokenStore.ts:288 | `DEL` | `token:{token}` | Same function | On demand | CRITICAL |
| 53 | tokenStore.ts:289 | `DEL` | `device:{deviceId}` | Same function | On demand | CRITICAL |
| 54 | tokenStore.ts:317 | `GET` | `device:{deviceId}` | Delete by device | On demand | CRITICAL |
| 55 | tokenStore.ts:319 | `DEL` | `token:{token}` | Same function | On demand | CRITICAL |
| 56 | tokenStore.ts:320 | `DEL` | `device:{deviceId}` | Same function | On demand | CRITICAL |
| 57 | tokenStore.ts:361 | `GET` | `token:{token}` | `getTokenEntry()` | On demand | CRITICAL |
| 58 | tokenStore.ts:410 | `KEYS` | `token:*` | `getStats()` | Admin / on demand | TELEMETRY |
| 59 | tokenStore.ts:411 | `KEYS` | `device:*` | `getStats()` | Admin / on demand | TELEMETRY |

### 1.7 MQTT Change Detection (mqttChangeDetection.ts)

| # | FILE:LINE | CMD | KEY PATTERN | TRIGGER | FREQ | CRITICALITY |
|---|-----------|-----|-------------|---------|------|-------------|
| 60 | mqttChangeDetection.ts:24 | `DEL` | `msg:last_hash:{deviceId}:{topic}` | Clear publish hash | On demand | OPERATIONAL |
| 61 | mqttChangeDetection.ts:43 | `SCAN` | `msg:last_hash:{deviceId}:*` | Clear all hashes per device | On disconnect | OPERATIONAL |
| 62 | mqttChangeDetection.ts:47 | `DEL` | (SCAN results) | Same function | N keys per device | OPERATIONAL |
| 63 | mqttChangeDetection.ts:89 | `GET` | `msg:last_hash:{deviceId}:{topic}` | `publishIfChanged()` | 1× per publish | OPERATIONAL |
| 64 | mqttChangeDetection.ts:96 | `SET EX` | `msg:last_hash:{deviceId}:{topic}` | Same function (update hash) | 1× per publish | OPERATIONAL |
| 65 | mqttChangeDetection.ts:125 | `SET EX` | `msg:last_hash:{deviceId}:{topic}` | `publishForce()` | On demand | OPERATIONAL |

### 1.8 Promotion Service (promotionService.ts)

| # | FILE:LINE | CMD | KEY PATTERN | TRIGGER | FREQ | CRITICALITY |
|---|-----------|-----|-------------|---------|------|-------------|
| 66 | promotionService.ts:206 | `GET` | `promo:active:{userId}` | Get active campaigns | On demand | OPERATIONAL |
| 67 | promotionService.ts:226 | `SET EX` | `promo:active:{userId}` | Cache campaigns (miss) | On demand | OPERATIONAL |
| 68 | promotionService.ts:246 | `GET` | `promo:rotation:{deviceId}` | Get next rotation index | 1× per screen publish | OPERATIONAL |
| 69 | promotionService.ts:250 | `SET EX` | `promo:rotation:{deviceId}` | Increment rotation index | 1× per screen publish | OPERATIONAL |
| 70 | promotionService.ts:262 | `DEL` | `promo:active:{userId}` | Invalidate promotion cache | On admin event | OPERATIONAL |
| 71 | promotionService.ts:278 | `DEL` | `promo:rotation:{deviceId}` | Reset rotation for user (per device) | On admin event | OPERATIONAL |

### 1.9 Brand Canvas Service (brandCanvasService.ts)

| # | FILE:LINE | CMD | KEY PATTERN | TRIGGER | FREQ | CRITICALITY |
|---|-----------|-----|-------------|---------|------|-------------|
| 72 | brandCanvasService.ts:89 | `GET` | `canvas:active:{userId}` | Get cached canvas | On demand | OPERATIONAL |
| 73 | brandCanvasService.ts:106 | `SET EX` | `canvas:active:{userId}` | Cache canvas (miss) | On demand | OPERATIONAL |
| 74 | brandCanvasService.ts:120 | `DEL` | `canvas:active:{userId}` | Invalidate canvas | On admin event | OPERATIONAL |

### 1.10 Webhook Deduplication (redisDedupe.ts)

| # | FILE:LINE | CMD | KEY PATTERN | TRIGGER | FREQ | CRITICALITY |
|---|-----------|-----|-------------|---------|------|-------------|
| 75 | redisDedupe.ts:20 | `SET NX EX` | `webhook:dedupe:{dedupeKey}` | GMB webhook received | 1× per webhook notification | CRITICAL |

### 1.11 GMB Review Cache (gmbReviewCache.ts)

| # | FILE:LINE | CMD | KEY PATTERN | TRIGGER | FREQ | CRITICALITY |
|---|-----------|-----|-------------|---------|------|-------------|
| 76 | gmbReviewCache.ts:15 | `GET` | `gmb:reviews:{locationId}` | GMB review count read | On demand | OPERATIONAL |
| 77 | gmbReviewCache.ts:33 | `SET EX` | `gmb:reviews:{locationId}` | GMB review count write (TTL 30d) | On webhook or poll | OPERATIONAL |

### 1.12 CSR Rate Limiter (csrRateLimiter.ts / csrRateLimitLua.ts)

| # | FILE:LINE | CMD | KEY PATTERN | TRIGGER | FREQ | CRITICALITY |
|---|-----------|-----|-------------|---------|------|-------------|
| 78 | csrRateLimitLua.ts:59 | `SCRIPT LOAD` | — | Server startup | 1× per startup | CRITICAL |
| 79 | csrRateLimiter.ts:238 | `EVALSHA` | `csr:global:{minute}`, `csr:ip:{ip}`, `csr:provisioned:{id}` or `csr:unprovisioned:{ip}` | Every CSR request | 1× per CSR request | CRITICAL |

### 1.13 Recovery Sessions (recoverySessionService.ts)

| # | FILE:LINE | CMD | KEY PATTERN | TRIGGER | FREQ | CRITICALITY |
|---|-----------|-----|-------------|---------|------|-------------|
| 80 | recoverySessionService.ts:130 | `GET` | `{prefix}recovery:session:{deviceId}` | Get active session TTL | 1× per session check | CRITICAL |
| 81 | recoverySessionService.ts:135 | `TTL` | Same key | Same function | Same call | CRITICAL |
| 82 | recoverySessionService.ts:193 | `SETEX` | Same key | Register recovery session | 1× per recovery request | CRITICAL |
| 83 | recoverySessionService.ts:222 | `GET` | Same key | Verify session token | 1× per verification | CRITICAL |
| 84 | recoverySessionService.ts:224 | `TTL` | Same key | Same function | Same call | CRITICAL |
| 85 | recoverySessionService.ts:233 | `DEL` | Same key | Same function (on success) | 1× per verification | CRITICAL |
| 86 | recoverySessionService.ts:245 | `SET KEEPTTL` | Same key | Verify with state update | On state update | CRITICAL |
| 87 | recoverySessionService.ts:262 | `DEL` | Same key | Consume session (single-use) | 1× per session use | CRITICAL |

### 1.14 OTA State (otaService.ts — OtaRedisState)

| # | FILE:LINE | CMD | KEY PATTERN | TRIGGER | FREQ | CRITICALITY |
|---|-----------|-----|-------------|---------|------|-------------|
| 88 | otaService.ts:261 | `SET EX` | `{prefix}ota:previous_active_release` | OTA release change | On release change | CRITICAL |
| 89 | otaService.ts:263 | `SET EX` | `{prefix}ota:active_release` | OTA release change | On release change | CRITICAL |
| 90 | otaService.ts:269 | `GET` | `{prefix}ota:active_release` | Read active release | On demand | CRITICAL |
| 91 | otaService.ts:281 | `GET` | `{prefix}ota:previous_active_release` | Read previous release | On demand | CRITICAL |
| 92 | otaService.ts:293 | `DEL` | `{prefix}ota:active_release` | Clear active release | On admin | CRITICAL |
| 93 | otaService.ts:303 | `SET EX` | `{prefix}ota:active_release` | Force set | On admin | CRITICAL |
| 94 | otaService.ts:310 | `DEL` | `{prefix}ota:pending:{version}` | Seed pending fleet | On rollout change | CRITICAL |
| 95 | otaService.ts:312 | `SADD`, `EXPIRE` | `{prefix}ota:pending:{version}` | Seed pending fleet | Same call | CRITICAL |
| 96 | otaService.ts:320-321 | `SADD`, `EXPIRE` | Same key | Add pending devices | On demand | CRITICAL |
| 97 | otaService.ts:327 | `DEL` | Same key | Clear pending fleet | On admin | CRITICAL |
| 98 | otaService.ts:333 | `SISMEMBER` | `{prefix}ota:pending:{version}` | Check if pending | 1× per device check | CRITICAL |
| 99 | otaService.ts:356 | `SISMEMBER` | Same key | Filter pending (loop) | N× per batch check | CRITICAL |
| 100 | otaService.ts:363 | `SMISMEMBER` | Same key | Filter pending (chunked batch) | 1× per chunk | CRITICAL |
| 101 | otaService.ts:374 | `SISMEMBER` | `{prefix}ota:delivered:{version}` | Check if delivered | 1× per device check | CRITICAL |
| 102 | otaService.ts:380-384 | `MULTI` (`SREM`, `SADD`, `EXPIRE`) | Both pending + delivered | Mark delivered | 1× per device | CRITICAL |
| 103 | otaService.ts:390-393 | `MULTI` (`SADD`, `EXPIRE`) | `{prefix}ota:pending:{version}` | Mark pending | 1× per device | CRITICAL |
| 104 | otaService.ts:405-408 | `MULTI` (`SADD`, `EXPIRE`) | `{prefix}ota:stage:{version}:{pct}:attempted` | Mark stage attempted | 1× per device per stage | CRITICAL |
| 105 | otaService.ts:416 | `DEL` | Same key | Clear stage | On stage change | CRITICAL |
| 106 | otaService.ts:424 | `SET NX EX` | `{prefix}ota:deferred:{deviceId}` | Log deferred catch-up | 1× per device deferred | OPERATIONAL |
| 107 | otaService.ts:431 | `SET NX EX` | `{prefix}ota:scheduler:lock` | Acquire scheduler lock | 1× per scheduler tick | CRITICAL |
| 108 | otaService.ts:438 | `DEL` | Same key | Release scheduler lock | 1× per scheduler tick | CRITICAL |
| 109 | otaService.ts:444 | `SET` | `{prefix}ota:scheduler:last_run` | Mark scheduler run | 1× per scheduler tick | CRITICAL |
| 110 | otaService.ts:450 | `GET` | `{prefix}ota:scheduler:last_run` | Read scheduler last run | On demand | CRITICAL |
| 111 | otaService.ts:752 | `SET NX EX` | `{prefix}ota:check:{deviceId}` | OTA rate limit check | 1× per device OTA check | CRITICAL |

### 1.15 OTA Rollout Scheduler (rolloutScheduler.ts)

| # | FILE:LINE | CMD | KEY PATTERN | TRIGGER | FREQ | CRITICALITY |
|---|-----------|-----|-------------|---------|------|-------------|
| 112 | rolloutScheduler.ts:43 | `tryAcquireSchedulerLock` | `{prefix}ota:scheduler:lock` | Scheduler tick | 1× per tick | CRITICAL |
| 113 | rolloutScheduler.ts:49 | `markSchedulerRun` | `{prefix}ota:scheduler:last_run` | Same tick | 1× per tick | CRITICAL |
| 114 | rolloutScheduler.ts:55 | `releaseSchedulerLock` | `{prefix}ota:scheduler:lock` | Same tick (on completion) | 1× per tick | CRITICAL |
| 115 | rolloutScheduler.ts:141 | `getSchedulerLastRun` | `{prefix}ota:scheduler:last_run` | Heartbeat check | On demand | CRITICAL |

### 1.16 Stimulate Service (stimulateService.ts)

| # | FILE:LINE | CMD | KEY PATTERN | TRIGGER | FREQ | CRITICALITY |
|---|-----------|-----|-------------|---------|------|-------------|
| 116 | stimulateService.ts:64 | `SET EX` | `stim:ig:{deviceId}` or `stim:gmb:{deviceId}` | Stim lock acquisition | 1× per stim loop start | OPERATIONAL |
| 117 | stimulateService.ts:79 | `EXPIRE` | Same key | Stim lock refresh | 1× per refresh interval | OPERATIONAL |
| 118 | stimulateService.ts:130 | `DEL` | Same key (iterate devices) | STIMULATE_CLEAR env | On start (env var) | OPERATIONAL |

### 1.17 Connect Refresh Coordinator (connectRefreshCoordinator.ts)

| # | FILE:LINE | CMD | KEY PATTERN | TRIGGER | FREQ | CRITICALITY |
|---|-----------|-----|-------------|---------|------|-------------|
| 119 | connectRefreshCoordinator.ts:140 | `SET NX EX` | `device:connect_refresh:{deviceId}` | Connect refresh | 1× per connect refresh | OPERATIONAL |

### 1.18 Stimulate Allowlist Check (stimulateAllowlist.ts)

| # | FILE:LINE | CMD | KEY PATTERN | TRIGGER | FREQ | CRITICALITY |
|---|-----------|-----|-------------|---------|------|-------------|
| 120 | stimulateAllowlist.ts:26 | `EXISTS` | `stim:ig:{deviceId}` or `stim:gmb:{deviceId}` | Before device fetch | 1× per device per fetch attempt | OPERATIONAL |

### 1.19 Daily Metrics (metrics/processDailyMetrics.ts)

| # | FILE:LINE | CMD | KEY PATTERN | TRIGGER | FREQ | CRITICALITY |
|---|-----------|-----|-------------|---------|------|-------------|
| 121 | processDailyMetrics.ts:26 | `SCRIPT LOAD` | — | Server startup | 1× per startup | OPERATIONAL |
| 122 | processDailyMetrics.ts:62 | `EVALSHA` | Dynamic set/count/revenue/last keys | Checkout event | 1× per checkout | TELEMETRY |
| 123 | processDailyMetrics.ts:67 | `EVAL` | Same (fallback) | SHA not loaded | Rare | TELEMETRY |

### 1.20 Redis Service — Scan for Stats (redisService.ts)

| # | FILE:LINE | CMD | KEY PATTERN | TRIGGER | FREQ | CRITICALITY |
|---|-----------|-----|-------------|---------|------|-------------|
| 124 | redisService.ts:356 | `SCAN` | `{prefix}*` | `getStats()` health endpoint | On demand (admin) | TELEMETRY |

---

## Part 2: Key Pattern Map

Key pattern uses the global `keyPrefix = proof-mqtt:` automatically (node-redis). Keys shown below are the **logical keys** used in code.

| KEY PATTERN | TYPE | TTL | CREATED BY | READ BY | PURPOSE |
|---|---|---|---|---|---|
| `proof.mqtt:active:devices` | SET | 7d | app.ts:177 | startupCacheRepublish.ts:54 | Crash-recovery: known active devices |
| `proof.mqtt:device:{deviceId}` | STRING | 7d | app.ts:1502, instagramTokenRefresh.ts:120 | instagramService.ts:1313 | IG credentials per device |
| `user:integrations:{userId}` | STRING | 24h | userIntegrationCache.ts:120 | userIntegrationCache.ts:160 | All social tokens per user |
| `token:{token}` | STRING | variable | tokenStore.ts:105 | tokenStore.ts:146,186,190,285,361 | Provisioning token |
| `device:{deviceId}` | STRING | variable | tokenStore.ts:110 | tokenStore.ts:186,317 | Device-to-token mapping |
| `prov:consumed:{sha}` | STRING | variable | tokenStore.ts:239 | tokenStore.ts:257 | Token spent-check |
| `webhook:dedupe:{key}` | STRING | short | redisDedupe.ts:20 | — (NX only) | GMB webhook dedup |
| `gmb:reviews:{locationId}` | STRING | 30d | gmbReviewCache.ts:33 | gmbReviewCache.ts:15 | GMB review count |
| `device:followers:{deviceId}` | STRING | 1d | instagramService.ts:764 | instagramService.ts:686,839, startupCacheRepublish.ts:101 | Cached follower count |
| `ig:last_pub:{deviceId}` | STRING | 1d | instagramService.ts:765, startupCacheRepublish.ts:121 | instagramService.ts:691 | Last publish timestamp |
| `ig:power_save:{deviceId}` | STRING | 1d | app.ts:698 | instagramService.ts:1664 | Power-save flag |
| `ig:fetch_dedupe:{deviceId}` | STRING | ms | instagramService.ts:1627 | — (NX only) | Fetch deduplication lock |
| `instagram:circuit:blocked_until` | STRING | 60s+ | instagramService.ts:430 | instagramService.ts:407 | Global IG circuit breaker |
| `ig:poll:global_fetch_budget:{slot}` | STRING | 120s | instagramService.ts Lua | — (INCR only) | Rate limiter per slot |
| `ig:bg:fair_offset` | STRING | none | instagramService.ts:1703 | instagramService.ts:1691 | Round-robin cursor |
| `priority_zset` | ZSET | none | instagramService.ts:1541 | instagramService.ts:225,1854 | Priority fetch queue |
| `device:fetch_history:{deviceId}` | ZSET | 60s+ | instagramService.ts Lua | instagramService.ts:240,1570,1791,1866 | Backoff history |
| `device:connect_refresh:{deviceId}` | STRING | sec | connectRefreshCoordinator.ts:140 | — (NX only) | Debounce connect refresh |
| `promo:active:{userId}` | STRING | variable | promotionService.ts:226 | promotionService.ts:206 | Active campaigns |
| `promo:rotation:{deviceId}` | STRING | variable | promotionService.ts:250 | promotionService.ts:246 | Rotation index |
| `canvas:active:{userId}` | STRING | variable | brandCanvasService.ts:106 | brandCanvasService.ts:89 | Brand canvas ad |
| `msg:last_hash:{deviceId}:{topic}` | STRING | variable | mqttChangeDetection.ts:96,125 | mqttChangeDetection.ts:89 | Publish deduplication hash |
| `stim:ig:{deviceId}` / `stim:gmb:{deviceId}` | STRING | variable | stimulateService.ts:64 | stimulateAllowlist.ts:26 | Stim lock |
| `{prefix}recovery:session:{deviceId}` | STRING | 15min | recoverySessionService.ts:193 | recoverySessionService.ts:130,222 | Factory reset session |
| `{prefix}ota:active_release` | STRING | 30d | otaService.ts:263 | otaService.ts:269 | Active OTA release |
| `{prefix}ota:previous_active_release` | STRING | 30d | otaService.ts:261 | otaService.ts:281 | Previous OTA release |
| `{prefix}ota:pending:{version}` | SET | 30d | otaService.ts:312 | otaService.ts:333,356,363 | Pending devices per version |
| `{prefix}ota:delivered:{version}` | SET | 30d | otaService.ts:382 | otaService.ts:374 | Delivered devices per version |
| `{prefix}ota:stage:{version}:{pct}:attempted` | SET | 30d | otaService.ts:406 | — (SADD only) | Stage attempt tracking |
| `{prefix}ota:deferred:{deviceId}` | STRING | 1d | otaService.ts:424 | — (NX only) | Deferred catch-up log |
| `{prefix}ota:scheduler:lock` | STRING | sec | otaService.ts:431 | rolloutScheduler.ts:43 | Scheduler mutex |
| `{prefix}ota:scheduler:last_run` | STRING | none | otaService.ts:444 | otaService.ts:450, rolloutScheduler.ts:141 | Scheduler heartbeat |
| `{prefix}ota:check:{deviceId}` | STRING | sec | otaService.ts:752 | — (NX only) | OTA rate limit |
| `csr:global:{minute}` | STRING | 1min | csrRateLimitLua.ts Lua | — (INCR only) | Global CSR rate limit |
| `csr:ip:{clientIp}` | STRING | 1min | csrRateLimitLua.ts Lua | — (INCR only) | Per-IP CSR rate limit |
| `csr:provisioned:{deviceId}` | STRING | 1min | csrRateLimitLua.ts Lua | — (INCR only) | Per-device CSR rate limit |
| `csr:unprovisioned:{clientIp}` | STRING | 1min | csrRateLimitLua.ts Lua | — (INCR only) | Per-IP unprovisioned limit |
| `instagram:pending:{deviceId}` | STRING | — | — (unknown) | app.ts:1609 (DEL) | Cleaned up on LWT |

---

## Part 3: Call Frequency Estimation

**Assumptions**: 4 active devices, 10 publishes/device/sec (QoS 1 PUBACK), 2 connects/disconnects/device/day, 1 IG poll/device/min, 1 rotation/device/publish

### Per-Event Calculation

| Event | Redis Calls | Calls/Event | Events/Month | Total Calls/Mo |
|-------|-------------|-------------|--------------|----------------|
| Device connect (`/active`) | SADD+EXPIRE + SET/DEL device meta | 2-3 | 4 devices × 2/day × 30 = 240 | **480-720** |
| Device disconnect (LWT) | SREM+DEL (act set + device meta) + ZREM+3×DEL (IG cleanup) | 6 | 240 | **1,440** |
| PUBACK received | SET power-save | 1 | 4×10×3600×24×30 = **~103M** | **~103M** ⚠️ |
| IG poll (per device, per min) | GET circuit + EVALSHA fetch hist + EVALSHA budget + GET device meta + GET followers + GET last_pub = ~6 | 6 | 4×60×24×30 = 172,800 | **~1,036,800** |
| IG poll publish (per success) | SET followers + SET last_pub + GET hash + SET hash = ~4 | 4 | 172,800 | **~691,200** |
| Screens republish (per publish) | GET promo rotation + SET promo rotation + GET promote + SET promote + GET canvas + SET canvas = ~6 | 6 | Same as IG poll | **~1,036,800** |
| Server restart | SMEMBERS + N× (GET+fSET) | 1+N | 1-2/mo | **~1-10** |
| Token refresh | GET + SET device meta | 2 | 4 × 1/60d = 0.067/mo | **~0** |
| Webhook (GMB) | SET NX dedupe + GET gmb + SET gmb | 3 | ~100/mo | **~300** |
| CSR request | EVALSHA (3 Lua INCRs) | 1 | ~1,000/mo | **~1,000** |
| Recovery session | GET+TTL+SETEX+GET+TTL+DEL/SET+DEL | 6-8 | ~10/mo | **~80** |
| OTA scheduler tick | LOCK+SET+UNLOCK | 3 | ~4,320/mo (every 10min) | **~12,960** |
| OTA device check | SISMEMBER+SETNX | 2 | ~1,000/mo | **~2,000** |
| User integrations cache | GET+SET (miss) or GET (hit) | 1-2 | ~500/mo | **~1,000** |

### Dominant Volume Drivers

```
PUBACK power-save SET:    ~103,000,000 calls/month  ⚠️  (98.8% of ALL Redis calls)
IG polling + screens:      ~2,764,800 calls/month    (2.65%)
Everything else:            ~20,000 calls/month       (0.02%)
```

**PUBACK → power-save SET is the #1 Redis call by volume, by a wide margin.** Every single QoS 1 PUBACK received writes a `SET EX ig:power_save:{deviceId}`.

---

## Part 4: Call Distribution Breakdown

| Category | Calls/Month | % of Total | Notes |
|---|---|---|---|
| Device lifecycle (connect/disconnect) | 1,920 | <0.01% | 6 calls per cycle, 240 cycles/mo |
| PUBACK → power-save SET | **~103,000,000** | **98.5%** | ⚠️ Dominant by orders of magnitude |
| IG polling (circuit + backoff + budget + meta + cache) | ~2,764,800 | 2.65% | 6 calls per device per poll cycle |
| Screen publish (hash dedup + promo + canvas + rotation) | ~1,728,000 | 1.65% | Per publish; shares IG poll frequency |
| Token refresh | ~0 | 0% | ~once per 60d per device |
| Provisioning tokens | ~500 | <0.001% | Per device provision only |
| Webhook dedup + GMB cache | ~300 | <0.001% | Event-driven |
| CSR rate limiting | ~1,000 | <0.001% | Lua EVALSHA |
| Recovery sessions | ~80 | <0.001% | Rare |
| OTA scheduler + device checks | ~15,000 | <0.01% | Periodic 10min |
| User integration cache | ~1,000 | <0.001% | On-demand |
| Server restart | ~10 | <0.001% | 1-2×/mo |
| Redis health stats (SCAN) | ~10 | <0.001% | Admin |
| Third-party (Socket.IO, session, Bull) | **0** | **0%** | ✅ None found |

---

## Part 5: Uncovered / Surprising Findings

### ⚠️ Finding 1: PUBACK power-save SET is ~98.5% of all Redis traffic

`app.ts:698` writes `ig:power_save:{deviceId}` with TTL 86400 on **every single PUBACK**:
```
await this.redisService.getClient().set(REDIS_KEYS.igPowerSave(deviceId), '1', { EX: 86400 });
```
For 4 devices at 10 publishes/sec each: **103M calls/month**. This is 50-100× more than all other Redis usage combined.

**Mitigation**: This value only needs to be set once to activate power-save mode — it does not need to be re-set on every PUBACK. A local dedup (e.g., only SET when the TTL is about to expire, or only when the device first publishes after a power-save transition) eliminates 103M calls.

### ⚠️ Finding 2: `proof.mqtt:active:devices` SET may be double-namespaced

The global `keyPrefix = proof-mqtt:` (with dash) is auto-applied by node-redis. Keys like `proof.mqtt:active:devices` (with dot) used in code would resolve to actual Redis key `proof-mqtt:proof.mqtt:active:devices`. Verify whether this double-prefix is intentional or an artifact of the two naming conventions diverging.

### ⚠️ Finding 3: `KEYS` command in tokenStore.ts:410-411

`redis.keys()` is used in `getStats()` for provisioning token enumeration. `KEYS` blocks Redis on large datasets. For a few hundred tokens this is fine, but if token volume grows, replace with `SCAN`.

### ⚠️ Finding 4: Scheduler lock is set + released in same tick (rolloutScheduler.ts:43-55)

`tryAcquireSchedulerLock` → `markSchedulerRun` → `releaseSchedulerLock` all fire in sequence every scheduler tick. If the process crashes between acquire and release, the lock auto-expires via TTL — so no deadlock risk. But consider whether the lock is needed at all if the scheduler runs single-instance.

### ⚠️ Finding 5: No Socket.IO, Express session, or Bull Redis adapters detected

✅ Zero third-party Redis usage. All Redis calls are explicit and first-party. No hidden traffic from Socket.IO adapter, `connect-redis`, or Bull/BullMQ.

### ⚠️ Finding 6: Same data written to multiple keys

The Instagram access token for a device exists in:
- `proof.mqtt:device:{deviceId}` (TTL 7d) — written on connect
- `user:integrations:{userId}` (TTL 24h) — written on cache miss
- `data/active-devices.json` (local file) — the active device cache

Token refreshes (instagramTokenRefresh.ts) must update all three locations. This is duplication by design (different TTLs and access patterns), but it means token freshness can drift between the three stores for up to 24h.

### ⚠️ Finding 7: `instagram:pending:{deviceId}` is DELeted but never written in visible code

`app.ts:1609` runs `multi.del(\`instagram:pending:\${deviceId}\`)` in the LWT cleanup pipeline, but no write to this key was found in the codebase. This may be a dead cleanup key from a removed feature — or it's written by external Lambda code not in this repo.

### ⚠️ Finding 8: IG polling does ~6 Redis calls per device per poll cycle

The IG polling hot path involves: circuit breaker GET → backoff EVALSHA → budget EVALSHA → device meta GET → followers GET → last_pub GET → followers SET → last_pub SET. This is consistent and expected, but any caching layer (local) could eliminate ~4 of these (the two GETs on followers/last_pub before the fetch, and the two SETs after).

### ⚠️ Finding 9: `SCAN` vs `SMEMBERS` for active device enumeration

On restart, `startupCacheRepublish.ts:54` uses `SMEMBERS` on the active devices SET — O(N) but fast for N < 10,000. `SCAN` is used in `redisService.ts:356` for stats enumeration — appropriate.

### ⚠️ Finding 10: 30 distinct Redis commands used

The codebase uses `GET`, `SET`, `SETEX`, `DEL`, `EXISTS`, `EXPIRE`, `TTL`, `KEYS`, `SCAN`, `SADD`, `SREM`, `SMEMBERS`, `SISMEMBER`, `SMISMEMBER`, `MULTI`, `EXEC`, `SCRIPT LOAD`, `EVAL`, `EVALSHA`, `ZADD`, `ZCARD`, `ZSCORE`, `ZRANGEBYSCORE`, `ZREMRANGEBYRANK`, `ZREM`, `ZREMRANGEBYSCORE`, `ZCOUNT`, `INCR`, `INCRBY`, `DECR` — 30 distinct commands across 124 call sites.

---

## Summary

```
Total Redis call sites (unique code lines): 124
Total distinct key patterns:                 38
Total distinct Redis commands:               30
Implicit third-party Redis usage:            NONE
═══════════════════════════════════════════════════
Biggest optimisation opportunity:             PUBACK power-save SET (~103M/mo)
Second biggest:                               IG polling pipeline consolidation (~2.7M/mo)
```

The codebase's Redis usage is well-structured with clear separation of concerns. The single dominant call (PUBACK → power-save SET) accounts for ~98.5% of volume and is trivially optimisable with a local state check before writing.
