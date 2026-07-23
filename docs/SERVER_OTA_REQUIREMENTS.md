# Server OTA Requirements (fleet rollout state machine)

Server-owned staged rollout for Proof Display firmware. **Firmware CI only publishes**; proofmqtt seeds canaries, advances stages, aborts on failure rate, and alerts Slack.

## Signing (locked)

| Field | Format |
|-------|--------|
| `sha256` | 64-char lowercase hex |
| `signature` | base64 Ed25519 over **UTF-8 bytes of sha256 hex** |

## Hash algorithm (FW-4)

```typescript
function deviceHashBucket(deviceId: string): number {
  return crypto.createHash('sha256').update(deviceId).digest()[0] % 100;
}
```

**Test vector:** `DEVICE-13` → bucket **40**.

Eligible when `hashBucket(deviceId) < currentPercentage` **OR** `deviceId` in `rollout.deviceIds`.

## CI webhooks

Auth: `Authorization: Bearer {OTA_RELEASE_WEBHOOK_SECRET}`

**This secret is high-privilege** (release + advance). Treat like an admin key; rotate carefully.

### `POST /api/webhooks/ota-release`

```json
{
  "version": "2.3.0",
  "object_key": "firmware/2.3.0/firmware.bin",
  "sha256": "<64 hex>",
  "signature": "<base64>",
  "size_bytes": 1195680,
  "released_at": "2026-07-23T12:00:00.000Z",
  "rollout": {
    "strategy": "percentage",
    "percentage": 1,
    "deviceIds": ["DEVICE-13"]
  }
}
```

- `rollout` is the sole push authority. Default percentage **1** if omitted.
- `broadcast` is **ignored** (warning logged if present).
- Sets `stageStartedAt`, seeds pending for eligible devices only, pushes MQTT to online eligible.
- Persists `previousVersion` on the release (Mongo) for abort restore.

### `POST /api/webhooks/ota-rollout-advance`

```json
{ "version": "2.3.0", "rollout": { "percentage": 10 } }
```

Monotonic steps only: **1 → 10 → 50 → 100**. Returns `409 ROLLOUT_ABORTED` if halted/aborted.

## Admin APIs

Base: `/api/v1/admin/ota` (admin JWT). Status/active also accept webhook Bearer.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/releases/{version}/rollout-status` | Stage stats + `can_advance` |
| GET | `/active-release` | In-progress STABLE or latest STABLE |
| POST | `/releases/{version}/halt` | Abort + revert active |
| POST | `/releases/{version}/mark-retryable` | `DEPRECATED` → `DEPRECATED_RETRYABLE` |
| POST | `/releases/{version}/retry` | `DEPRECATED_RETRYABLE` → `STABLE` |

### `can_advance`

```
!aborted && percentage < 100 && hoursSince(stage_started_at) >= 24
  && attempted >= 20 && failure_rate < 0.01
```

## MQTT `ota_update` (FW-4)

```json
{
  "cmd": "ota_update",
  "version": "2.3.0",
  "rollout": { "strategy": "percentage", "percentage": 10 },
  "download_url": "...",
  "sha256": "...",
  "signature": "...",
  "size_bytes": 1195680,
  "issued_at": "..."
}
```

Pre-FW-4 devices must ignore unknown fields or stay out of early canary cohorts.

## Device failure reasons

| Code (underscore or hyphen) | Stage counters | Blacklist |
|-----------------------------|----------------|-----------|
| `download_failed`, `download_timeout` | failed++ | After **3** strikes |
| `sha256_mismatch`, `signature_invalid`, `flash_error` | failed++ | Immediate |
| `health_check_failed` | failed++ and rolled_back++ | Immediate |
| `rollback` | rolled_back++ | Immediate |
| `track_mismatch` | none | none |

## Abort

When `attempted >= 20` and `(failed + rolled_back) / attempted >= 0.01`:

- status → `DEPRECATED`, `aborted = true`
- restore Redis `ota:active_release` from Mongo `previousVersion`
- clear pending; Slack critical

## Env

```
OTA_STAGE_ABORT_MIN_SAMPLE=20
OTA_STAGE_ABORT_FAILURE_RATE=0.01
OTA_STAGE_MIN_HOURS=24
SLACK_OTA_WEBHOOK_URL=
OTA_DASHBOARD_URL=
OTA_MQTT_PUSH_CONCURRENCY=100
OTA_RELEASE_WEBHOOK_SECRET=
```

## Scheduler

Recursive `setTimeout` every 5 minutes + Redis lock `EX 300`. Auto-abort, auto-advance, stuck Slack, scheduler-dead if `last_run` stale > 15 min.
