# Attention polling — implementation status

This document summarizes attention-weighted IoT Instagram polling across roadmap phases **A–G** for the **current architecture**:

**Main server (Render)** holds Redis Lua scheduling, MQTT lifecycle, and calls an **HTTPS POST** to a **serverless worker** (e.g. **Vercel**) that talks to **Instagram Graph API**. Results return in JSON; the server writes Mongo/Influx, updates **`device:followers:{id}`**, and publishes MQTT **`screen_update`** when the device is online (no Kafka, no HTTP `/attention`).

For historical roadmap bullets, see `attention-iot-polling-roadmap.mdc`.

---

## Dual schedulers — priority and background (both implemented)

Idle devices stay in **`full_active_set`** but fall out of the **current** priority window when their **`priority_zset`** score is ≤ **now** (expired). Those devices are picked up only by the **background** path.

| Lane | Default cadence | Where devices come from | Serverless batch `trigger` |
|------|-----------------|-------------------------|----------------------------|
| **Priority** | **`IG_POLL_PRIORITY_INTERVAL_MS`** (15s) | **`priority_zset`**: Lua **`atomicPriorityReadAndPrune`** returns members with score **>** now | **`scheduled`** (poller batches); registration scan also fires **`attention`** via **`requestImmediateFetch`** |
| **Background** | **`IG_POLL_BACKGROUND_INTERVAL_MS`** (90s) | **`full_active_set`** ∖ devices in active priority window — Lua **`atomicBackgroundSubtraction`** | **`scheduled`** |

- **Timers:** **`InstagramPoller.start()`** registers **`setInterval(..., priorityIntervalMs)`** and **`setInterval(..., backgroundIntervalMs)`**, and runs **`priorityScheduler`** and **`backgroundScheduler`** once immediately.
- **Background extras:** **`filterOutPowerSave`**, **`takeBackgroundWindow`** (optional **`IG_POLL_BACKGROUND_CAP_PER_CYCLE`**, Redis **`ig:bg:fair_offset`** rotation), same backoff / **`IG_FETCH_DEDUPE_WINDOW_MS`** / **`IG_GLOBAL_FETCH_BUDGET_PER_MIN`** as priority.

Implementation: **`src/services/instagramPoller.ts`** — private methods **`priorityScheduler`** and **`backgroundScheduler`** (not separate `app.ts` intervals; both live on the poller).

---

## Phase A — Operations and configuration hardening

### Serverless endpoint (required for poller)
- **`INSTAGRAM_SERVERLESS_URL`** — full POST URL for batch/single fetch (alias **`VERCEL_INSTAGRAM_FETCH_URL`**).
- **`INSTAGRAM_SERVERLESS_API_KEY`** — optional **`x-api-key`** header (alias **`VERCEL_INSTAGRAM_FETCH_API_KEY`**).
- **`INSTAGRAM_SERVERLESS_TIMEOUT_MS`** — HTTP timeout (default `30000`).

### Tunable polling (`InstagramPollingConfig` / `IG_POLL_*`, `IG_FETCH_*`)
- Priority / background intervals, batch size, priority TTL, backoff threshold/window.
- **`IG_POLL_BACKGROUND_INTERVAL_MULTIPLIER_LOW_POWER`** — stretches background interval.
- Dedupe: **`IG_FETCH_DEDUPE_WINDOW_MS`** (Redis **`SET NX PX`** per device).
- Fairness / budgets: **`IG_POLL_*`**, **`IG_GLOBAL_FETCH_BUDGET_PER_MIN`** (atomic Lua minute bucket).

### Health and readiness
- **`GET /health`** — liveness (`src/servers/httpServer.ts`).
- **`GET /ready`** — when **`INSTAGRAM_SERVERLESS_URL`** is set: Redis, poller running, Lua loaded, **`instagram_serverless_configured`**, **`metrics`** snapshot (`buildReadinessPayload` in **`src/app.ts`**).

### Smoke
- **`npm run smoke:attention`** — **`/health`** + **`/ready`**.

### Code references
- **`src/config/index.ts`** — **`InstagramServerlessConfig`**, **`instagramPolling`**.
- **`src/services/instagramServerlessBridge.ts`** — HTTP contract + parsing.

---

## Phase B — Attention / priority signals

### Intended flow (device scan / NFC)
- MQTT **`{topicRoot}/+/active`** (**registration / reconnect**) → **`handleDeviceRegistration`**:
  - **`SADD`** **`full_active_set`**, **`markPriority(deviceId)`**, fire-and-forget **`requestImmediateFetch(deviceId)`** (serverless **`trigger: attention`**, backoff + circuit + dedupe + budget).
- **`power_save` / `power_mode: low`** on **`/active`** → Redis **`ig:power_save:{deviceId}`** (background deferral).

### Removed (previous iteration)
- HTTP **`POST .../attention`**.
- MQTT **`+/attention`** subscription.

### Code references
- **`src/app.ts`** — **`handleDeviceRegistration`**, **`setDevicePowerSaveFlag`**.

---

## Phase C — Fairness, starvation, budgets

Unchanged concepts: **`priority_zset`** caps/decay/ceilings, background fair rotation (**`ig:bg:fair_offset`**), power-save filtering, global **`IG_GLOBAL_FETCH_BUDGET_PER_MIN`** via **`atomicFetchBudgetTryLua`** — applied **before each serverless invoke**, not Kafka publish.

**References:** **`instagramPoller.ts`**, **`instagramPollingLua.ts`**, **`instagramPollingScripts.ts`**.

---

## Phase D — Observability

- **Counters / E2E histogram:** **`instagramPollingMetrics.ts`** ( **`registerAttentionCorrelationStart`** still runs immediately before serverless POST for **`requestImmediateFetch`** ).
- **Apply path:** **`instagramServerlessOutcome.ts`** — Influx **`instagram_fetch_audit`** (full audit row per attempt), **`instagram_metrics`**, **`instagram_attention_e2e`**; **`observeAttentionFetchLatencyMs`** / **`abandonAttentionCorrelation`**; MQTT via **`instagramScreenDelivery.ts`**. Helpers on **`InfluxService`**: **`writeInstagramFetchAudit`**, **`writeInstagramFollowersGauge`**, **`writeInstagramAttentionE2eLatency`**, **`flushWrites`**.
- **MQTT **`correlation_id`**:** carried on **`screen_update`** when present.

---

## Phase E — Topology & dedupe

- **No Kafka.** Each **priority** and **background** tick produces one or more batched POSTs (chunked by **`IG_POLL_BATCH_SIZE`**), plus optional one-off **`requestImmediateFetch`** on **`/active`**.
- **Dedupe:** **`IG_FETCH_DEDUPE_WINDOW_MS`** before each device is included in a batch.

---

## Phase F — Testing

- Smoke script only; no bundled chaos/integration suite.

---

## Phase G — IoT UX

- **`ig:power_save:*`** from **`/active`** payload only (attention topic removed).
- **Offline:** Instagram screen payload is **not** queued to **`instagram:pending:*`** anymore — updates are skipped when the device is not in the active cache.

---

## Serverless JSON contract (reference)

**Request (POST JSON):**

```json
{
  "deviceIds": ["device-a", "device-b"],
  "trigger": "scheduled",
  "correlation_id": "optional-uuid-for-single-attention-invoke"
}
```

**Response (200):** flexible parsing supports **`results`** as an array of rows **or** as an object map from **`deviceId`** to row. Each row may include **`deviceId`**, **`success`**, **`followers_count`** (or **`data.followers_count`**), **`error`**, **`instagram_account_id`**, **`api_response_time_ms`**, **`http_status`**, **`retry_after_seconds`**, **`error_code`** (for circuit breaker). Optional root **`circuit_open_seconds`**.

---

## Quick env reference

| Env | Purpose |
|-----|---------|
| `INSTAGRAM_SERVERLESS_URL` | POST endpoint for Instagram fetch worker |
| `INSTAGRAM_SERVERLESS_API_KEY` | Optional API key header |
| `INSTAGRAM_SERVERLESS_TIMEOUT_MS` | HTTP timeout |
| `IG_POLL_*`, `IG_FETCH_*`, `IG_GLOBAL_FETCH_BUDGET_PER_MIN` | Scheduler / dedupe / budget |
| `SMOKE_BASE_URL` | Smoke script base URL |

---

## Summary table

| Phase | Theme | Status |
|-------|--------|--------|
| **A** | Env, readiness, smoke | Updated for serverless URL |
| **B** | Priority via **`/active`** | Implemented; HTTP/MQTT attention removed |
| **C** | Fairness / budgets | Same Lua + poller semantics |
| **D** | Metrics / Influx / correlation | Wired through **`instagramServerlessOutcome`** |
| **E** | HTTPS batch worker + dedupe | Replaces Kafka |
| **F** | Automated tests | Minimal |
| **G** | Power-save | **`/active`** only; pending queue removed |

---

*Filename note: requested “attendtion polling status”; this file is **`attention-polling-status.md`** (correct spelling).*
