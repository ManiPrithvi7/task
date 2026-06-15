# OTA Firmware Contract (server ↔ device v4.3)

Server-side API and MQTT schemas for the Proof Display OTA system. Device behavior is defined in [Proof Display OTA .md](./Proof%20Display%20OTA%20.md).

## Enable OTA

```bash
OTA_ENABLED=true
OTA_OCI_NAMESPACE=your-tenancy-namespace
OTA_OCI_BUCKET=your-bucket
OTA_OCI_REGION=ap-hyderabad-1
OCI_CONFIG_FILE=~/.oci/config
OCI_CONFIG_PROFILE=DEFAULT
OTA_SIGNING_CONFIRMED=true   # or POST /api/v1/admin/ota/signing-confirm after device E2E
OTA_ED25519_PUBLIC_KEY_PATH=/path/to/ota_public.pem
```

## Signing contract (locked)

| Field | Format |
|-------|--------|
| `sha256` | 64-char lowercase hex (digest of firmware bytes) |
| `signature` | **base64** encoding of 64-byte Ed25519 signature |
| Signed message | UTF-8 bytes of the `sha256` hex string (not raw binary digest) |

Server verifies signature at `POST /releases/finalize`. Device verifies again before flash.

## Storage — Oracle Cloud Object Storage (PAR)

Firmware binaries live in OCI Object Storage. Admin upload uses **Pre-Authenticated Request (PAR)** URLs (`ObjectWrite`). Device download uses fresh **PAR** URLs (`ObjectRead`) per check/push offer.

Upload PUT headers (required):

| Header | Value |
|--------|-------|
| `opc-meta-firmware-version` | Release version (e.g. `4.3.1-mvp`) |
| `opc-meta-sha256` | 64-char lowercase SHA-256 hex |

Device accepts version from response headers: `X-Firmware-Version`, `x-amz-meta-firmware-version`, or `opc-meta-firmware-version`.

## CI webhook — automated release + broadcast

GitHub Actions (statsclient) uploads a signed binary to OCI, then calls:

`POST /api/webhooks/ota-release`

**Auth:** `Authorization: Bearer {OTA_RELEASE_WEBHOOK_SECRET}`

**Body:**

```json
{
  "version": "4.3.1-mvp",
  "object_key": "firmware/4.3.1-mvp/firmware.bin",
  "sha256": "<64 hex>",
  "signature": "<base64 Ed25519>",
  "size_bytes": 1124528,
  "released_at": "2026-06-15T12:00:00.000Z",
  "broadcast": true
}
```

Server validates object metadata + signature (same as finalize), upserts a **stable** release, and publishes `ota_update` on `{MQTT_TOPIC_ROOT}/broadcast/cmd` with a fresh PAR `download_url`.

Boot-up devices catch up via `GET /api/v1/ota/check?current_version=...` (no periodic polling).

### Storage error codes

| `code` | HTTP | Meaning |
|--------|------|---------|
| `OBJECT_NOT_FOUND` | 404 | Object missing in bucket |
| `STORAGE_UNAVAILABLE` | 503 | OCI timeout / transient failure |
| `STORAGE_FORBIDDEN` | 403 | IAM / credentials issue |
| `STORAGE_BAD_REQUEST` | 400 | Invalid key or PAR request |
| `STORAGE_ERROR` | 500 | Unknown storage error |

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
  "download_url": "https://objectstorage....oraclecloud.com/p/...",
  "sha256": "<64 hex>",
  "signature": "<base64 Ed25519>",
  "size_bytes": 1234567,
  "expires_at": "2026-06-12T12:15:00.000Z"
}
```

**Rate limit:** 1 request per device per 5 minutes (configurable via `OTA_CHECK_RATE_LIMIT_SEC`).

## Device HTTP — `GET /api/v1/ota/download/:version` (proxy mode)

When `OTA_DOWNLOAD_MODE=proxy`, `download_url` points here. Response includes header `X-Firmware-Version: {version}`.

Default mode (`presigned`) returns a direct OCI PAR URL; object metadata must include `opc-meta-firmware-version`.

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
| POST | `/releases/init` | OCI PAR upload URL + `object_key` |
| POST | `/releases/finalize` | Verify SHA-256 + Ed25519 + metadata; create draft |
| POST | `/releases/:version/promote` | Draft → stable (requires signing confirmed) |
| POST | `/signing-confirm` | Enable promote after successful device OTA E2E |
| GET | `/releases` | List releases |
| GET | `/devices/:deviceId/ota` | Device OTA state |
| POST | `/push` | Push update to device(s) or broadcast |

### Signing confirmation

After first successful OCI-backed device OTA, either:

1. Set `OTA_SIGNING_CONFIRMED=true` in server `.env`, or
2. `POST /api/v1/admin/ota/signing-confirm` with `{ "confirmed": true, "notes": "..." }`

## Finalize validation (server)

At `POST /releases/finalize`, server checks in order:

1. Object exists (`headObject`) with non-zero size ≤ 2 MB
2. `opc-meta-firmware-version` and `opc-meta-sha256` match request
3. Streamed SHA-256 matches `sha256` field
4. Ed25519 signature (base64) over UTF-8 sha256 hex

## PAR expiration

Default TTL: `OTA_PRESIGNED_TTL_SEC=900` (15 min). If a PAR expires before download completes, device retries via `ota_check` or a new MQTT push (fresh PAR issued each offer).
