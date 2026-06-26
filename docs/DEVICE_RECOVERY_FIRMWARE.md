# Device recovery API (firmware contract)

Factory reset / certificate reissue uses a **dashboard-issued JWT** registered in Redis. Firmware must accept the token end-to-end (no 6-digit recovery codes).

## Dashboard → user

1. User calls Next.js `POST /api/recovery/generate-session` with `{ "device_id": "DEVICE-XX" }`.
2. Response: `{ "token": "<jwt>", "expires_in": 900, "device_id": "DEVICE-XX" }`.
3. Portal URL shown to user: `http://192.168.4.1/?token=<jwt>` (device AP).

JWT claims (HS256, `AUTH_SECRET` shared with MQTT server):

| Claim | Value |
|-------|--------|
| `sub` | Mongo user id |
| `device_id` | Normalized device id |
| `jti` | UUID (session id) |
| `purpose` | `device-reset-recovery` |
| `exp` | ~15 minutes |

## Device AP — `POST /api/recovery/restore`

Request body:

```json
{
  "ssid": "MyWiFi",
  "password": "secret",
  "token": "<jwt from query string>"
}
```

Optional alias: `recovery_token` (same value as `token`).

Device should parse `device_id` from the JWT payload (do not trust a separate client-supplied device id for MQTT).

## Device → MQTT — `POST /api/v1/certificates/reissue`

No user `Authorization` header. Body:

```json
{
  "device_id": "DEVICE-XX",
  "csr": "<PEM or base64 PEM CSR>",
  "recovery_token": "<same jwt>"
}
```

Alias: `token` instead of `recovery_token`.

On success, MQTT **consumes** the Redis session (single-use). A second reissue with the same JWT returns `410 SESSION_EXPIRED`.

## MQTT — register session (dashboard proxy only)

`POST /api/v1/recovery/generate-session`

- Header: `Authorization: Bearer <user JWT>` (dashboard session).
- Body: `{ "device_id", "token", "force_reissue"?: boolean }` where `token` is the device recovery JWT from Next.js.
- When `force_reissue` is `true`, an existing Redis session for the device is **replaced** (fresh TTL, new JWT). Dashboard should send this on every factory-reset generate-session call.
- When `force_reissue` is omitted or `false`, an active session returns **429** instead of replacing.

## Errors (firmware handling)

| Code | HTTP | Meaning |
|------|------|---------|
| `SESSION_EXPIRED` | 410 | No Redis session or already used |
| `SESSION_INVALID` | 401 | JWT/hash mismatch |
| `GENERATE_RATE_LIMITED` | 429 | Active session still exists (`force_reissue` not set) |

## Environment

- `AUTH_SECRET` must match on Next.js (Vercel) and MQTT host.
- Redis key: `{REDIS_KEY_PREFIX}recovery:session:{device_id}` (default prefix `mqtt-lite:`).
