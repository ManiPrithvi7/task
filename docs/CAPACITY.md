# Fleet Capacity Documentation

> **Untested** — The following limits are derived from code, not tested in production load scenarios. Start with 100–500 devices for pilot Phase 1.

## Current Code-Derived Limits

| Limit | Source | Default | Notes |
|-------|--------|--------|-------|
| **MongoDB Pool Size** | `src/config/index.ts` (line 9) | `maxPoolSize: 10`, `minPoolSize: 2` | Not configurable in code |
| **Message Buffer** | `src/servers/mqttIngressRouter.ts:70` | `MESSAGE_BUFFER_MAX: 100` | Drop oldest messages when full |
| **CSR Rate Limit** | `src/services/provisioningService.ts:112` | `100 CSRs / 1 minute` | Redis + in-memory fallback |
| **IG Poll Batch Size** | `src/config/index.ts:56` | `IG_POLL_BATCH_SIZE: 50` | 50 Instagram profiles per batch |
| **Session TTL** | `src/config/index.ts:20` | `86400s` | 24 hours |
| **MQTT retries** | `src/servers/mqttClient.ts:19` | `5 attempts` | Exponential backoff |
| **Pending ACKs** | `src/servers/mqttClient.ts:34` | **Unbounded** | `Map<number, Buffer>` grows with network loss |
| **Deferred work TTL** | `src/services/deferredDeviceWork.ts` | 30s stale drop | In-memory; not multi-instance; alert on `skippedStale` |
| **OTA defer concurrency** | `OTA_REGISTRATION_DEFER_CONCURRENCY` | 10 | Caps parallel OTA delivers on registration |

## Reconnect storm (manual / scheduled)

Not in CI. After significant broker outage:

1. Run a controlled reconnect storm against staging (or `scripts/ota-e2e/` harness when available).
2. Watch `[DEFERRED_WORK] Drain complete` for rising `skippedStale` / `failed`.
3. Watch `[MQTT_INGRESS] Message buffer overflow`.

See [docs/runbooks/deferred-queue-backlog.md](runbooks/deferred-queue-backlog.md).

## Redis Storage Limits

Redis is required for rate limiting and session storage. Even though there's no pool size config, typical deployment should account for:

- **Per-device keys:** Each device creates multiple Redis keys including:
  - `device:followers:{id}` — stores follower list
  - `device:fetch_history:{id}` — stores hashtag fetch metadata
  - `ig:power_save:{id}` — Instagram access token storage
  - OTA keys under `mqtt-lite:ota:*` prefix
- **No pool limits** — Redis client uses the system default connection pool unless configured otherwise

## Operational Recommendations

### Conservative Estimate for Pilot v1
- **Target fleet size:** 100–500 devices  
- **Primary test focus:** MongoDB connection pool, message buffering, and Redis per-device memory usage

### Scaling Considerations

1. **MongoDB:** Increase pool size if `MESSAGE_BUFFER_MAX` remains full
2. **MQTT pending ACKs:** Review network stability if `Map` growth is significant
3. **Redis:** Monitor memory as device count increases
4. **Rate limits:** Adjust to accommodate pilot telemetry requirements

## Performance Notes

- **Untested:** All limits above are derived from static code inspection, not production load testing
- **Load testing needed:** Battery of measures before GA (see POST-PILOT_ROADMAP.md)
- **Fallbacks:** In-memory rate limit fallbacks when Redis unavailable (CSR limiter)

## Gaps to Address Post-Pilot

- Global HTTP rate limiting (see P3.3 in POST-PILOT_ROADMAP.md)
- Multi-instance rate limiting with Redis-backed store
- Quantified fleet performance characteristics (messages/sec, device-join patterns)
