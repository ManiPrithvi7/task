# OTA Firmware Contract (server ↔ device v4.3)

Server-side API and MQTT schemas for the Proof Display OTA system. Device behavior is defined in [Proof Display OTA .md](./Proof%20Display%20OTA%20.md).

## Enable OTA

```bash
OTA_ENABLED=true
OTA_S3_BUCKET=your-bucket
OTA_S3_REGION=us-east-1
# Optional IAM keys (omit on EC2/ECS with instance role)
# OTA_S3_ACCESS_KEY_ID=
# OTA_S3_SECRET_ACCESS_KEY=
OTA_SIGNING_CONFIRMED=true   # after firmware confirms Ed25519 payload format
```

## Device HTTP — `GET /api/v1/ota/check`

**Auth:** mTLS (primary device certificate), same as cert renewal.

**Query:**

| Param | Required | Description |
|-------|----------|-------------|
| `current_version` | yes | Running firmware version |
| `hardware_rev` | no | Hardware revision gate |
| `platform` | no | Platform identifier |

**No update:**

```json
{ "update_available": false, "server_time": "2026-06-12T12:00:00.000Z" }
```

**Update available:**

```json
{
  "update_available": true,
  "version": "4.3.1",
  "download_url": "https://...",
  "sha256": "<64 hex>",
  "signature": "<base64 Ed25519>",
  "size_bytes": 1234567,
  "expires_at": "2026-06-12T12:15:00.000Z"
}
```

**Rate limit:** 1 request per device per 5 minutes (configurable via `OTA_CHECK_RATE_LIMIT_SEC`).

## Device HTTP — `GET /api/v1/ota/download/:version` (proxy mode)

When `OTA_DOWNLOAD_MODE=proxy`, `download_url` points here. Response includes header `X-Firmware-Version: {version}`.

Default mode (`presigned`) returns a direct S3 URL; object metadata must include `x-amz-meta-firmware-version`.

## Device HTTP — `POST /api/v1/ota/report` (optional fallback)

Same mTLS auth and rate limit as `/check`. Body uses same event keys as MQTT `/status` (see below).

## MQTT — server → device commands

Topics: `{MQTT_TOPIC_ROOT}/{deviceId}/cmd`, `{MQTT_TOPIC_ROOT}/broadcast/cmd`

**Full update push:**

```json
{
  "cmd": "ota_update",
  "version": "4.3.1",
  "download_url": "https://...",
  "sha256": "...",
  "signature": "...",
  "size_bytes": 1234567,
  "force": false,
  "issued_at": "2026-06-12T12:00:00.000Z"
}
```

**Poll trigger only:**

```json
{
  "cmd": "ota_check",
  "force": false,
  "hint_version": "4.3.1",
  "issued_at": "2026-06-12T12:00:00.000Z"
}
```

QoS: 1, retain: false.

## MQTT — device → server telemetry

Topic: `{MQTT_TOPIC_ROOT}/{deviceId}/status`

| Event (`type` or `event`) | Description |
|---------------------------|-------------|
| `ota_progress` | Download in progress |
| `ota_validating` | Post-reboot validation |
| `ota_success` | Update validated; include `version` |
| `ota_rollback` | Rollback; include `attempted_version`, `reason` or `reasons[]` |

## MQTT — server → device rollback ack

Topic: `{MQTT_TOPIC_ROOT}/{deviceId}/ack`

```json
{
  "cmd": "ota_rollback_received",
  "version": "4.3.1",
  "received_at": "2026-06-12T12:00:00.000Z"
}
```

Device retries up to 5 times (QoS 1) until ack received.

## Admin API (Bearer user JWT)

Base: `/api/v1/admin/ota`

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/releases/init` | Presigned S3 PUT URL |
| POST | `/releases/finalize` | Verify SHA-256, create draft |
| POST | `/releases/:version/promote` | Draft → stable (requires `OTA_SIGNING_CONFIRMED`) |
| GET | `/releases` | List releases |
| GET | `/devices/:deviceId/ota` | Device OTA state |
| POST | `/push` | Push update to device(s) or broadcast |

## Open firmware dependencies

1. **Ed25519 signing payload** — confirm exact signed bytes before production `promote`.
2. **MQTT field names** — defaults above use `cmd` key per v4.3 convention.
