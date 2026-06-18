# OTA Firmware Contract (server ↔ device v4.3)

Server-side API and MQTT schemas for the Proof Display OTA system. Device behavior is defined in [Proof Display OTA .md](./Proof%20Display%20OTA%20.md).

## Enable OTA

Bucket `proof-firmware-ota` (namespace `ax4egmknthnr`, region `ap-hyderabad-1`) is **hardcoded** in `src/config/otaDefaults.ts`. On deploy, set **secrets only**:

```bash
OTA_ENABLED=true
OCI_TENANCY_OCID=ocid1.tenancy.oc1..xxxx
OCI_USER_OCID=ocid1.user.oc1..xxxx
OCI_FINGERPRINT=aa:bb:cc:...
OCI_API_PRIVATE_KEY_BASE64=<base64 PEM of API private key>
OTA_ED25519_PUBLIC_KEY_BASE64=<base64 PEM of Ed25519 public key>
OTA_RELEASE_WEBHOOK_SECRET=<shared secret for GitHub Actions webhook>
```

Do **not** use `OCI_CONFIG_FILE` — credentials must live in env vars in every environment.

PAR base URL is derived automatically: `https://{namespace}.objectstorage.{region}.oci.customer-oci.com`

## Signing contract (locked)

| Field | Format |
|-------|--------|
| `sha256` | 64-char lowercase hex (digest of firmware bytes) |
| `signature` | **base64** encoding of 64-byte Ed25519 signature |
| Signed message | UTF-8 bytes of the `sha256` hex string (not raw binary digest) |

Server verifies signature at `POST /releases/finalize`. Device verifies again before flash.

## Storage — Oracle Cloud Object Storage (PAR)

Firmware binaries live in OCI Object Storage. Admin upload uses **Pre-Authenticated Request (PAR)** URLs (`ObjectWrite`). Device download uses fresh **PAR** URLs (`ObjectRead`) per push offer.

Upload PUT headers (required):

| Header | Value |
|--------|-------|
| `opc-meta-firmware-version` | Release version (e.g. `4.3.1-mvp`) |
| `opc-meta-sha256` | 64-char lowercase SHA-256 hex |

Device accepts version from response headers: `X-Firmware-Version`, `x-amz-meta-firmware-version`, or `opc-meta-firmware-version`.

## CI webhook — automated release + per-device push

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

Server validates object metadata + signature (same as finalize), upserts a **stable** release, seeds Redis pending fleet state, and publishes `ota_update` on `{MQTT_TOPIC_ROOT}/{deviceId}/cmd` (QoS 2) for each **online** device still pending.

Offline devices catch up when they publish `/active` with `appVersion` — the server re-pushes a fresh PAR if the device is still in the pending set.

### Storage error codes

| `code` | HTTP | Meaning |
|--------|------|---------|
| `OBJECT_NOT_FOUND` | 404 | Object missing in bucket |
| `STORAGE_UNAVAILABLE` | 503 | OCI timeout / transient failure |
| `STORAGE_FORBIDDEN` | 403 | IAM / credentials issue |
| `STORAGE_BAD_REQUEST` | 400 | Invalid key or PAR request |
| `STORAGE_ERROR` | 500 | Unknown storage error |

## Device HTTP — `GET /api/v1/ota/download/:version` (proxy mode, optional)

When `OTA_DOWNLOAD_MODE=proxy`, this HTTP route streams firmware from OCI (requires device mTLS reaching the Node app). Response includes header `X-Firmware-Version: {version}`.

**MQTT `ota_update` always carries a direct OCI presigned PAR URL** in `download_url` (works on Railway and all production edges). Object metadata must include `opc-meta-firmware-version`.

## Device HTTP — `POST /api/v1/ota/report` (optional fallback)

Same mTLS auth and rate limit as before. Body uses same event keys as MQTT `/status` (see below).

**Note:** `GET /api/v1/ota/check` and MQTT `ota_check` are **removed**. The server pushes updates; devices do not poll.

## MQTT — server → device commands

Topics: `{MQTT_TOPIC_ROOT}/{deviceId}/cmd`

**Full update push (only delivery mechanism):**

```json
{
  "cmd": "ota_update",
  "version": "4.3.1",
  "download_url": "https://{namespace}.objectstorage.{region}.oci.customer-oci.com/p/.../firmware.bin",
  "sha256": "...",
  "signature": "...",
  "size_bytes": 1234567,
  "force": false,
  "issued_at": "2026-06-12T12:00:00.000Z"
}
```

Per-device `ota_update`: QoS **2**, retain: false.

Legacy broadcast topic `{MQTT_TOPIC_ROOT}/broadcast/cmd` remains for admin manual broadcast only (QoS 1).

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
| POST | `/push` | Push full `ota_update` to device(s) or broadcast |

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

Default TTL: `OTA_PRESIGNED_TTL_SEC=900` (15 min). If a PAR expires before download completes, the device waits for a new server push (registration catch-up or admin push) with a fresh PAR.

## Redis fleet state (server)

| Key | Purpose |
|-----|---------|
| `{prefix}ota:active_release` | Current stable release manifest |
| `{prefix}ota:pending:{version}` | Devices still needing this version |
| `{prefix}ota:delivered:{version}` | Devices confirmed (MQTT QoS 2 ack or `ota_success`) |
