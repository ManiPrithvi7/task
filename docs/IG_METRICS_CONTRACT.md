# Instagram Metrics API Contract

Cross-repo contract between **proofmqtt** (metrics server) and the **statsnapp web app** for Instagram Basic Scope follower metrics.

## Division of labor

| Concern | Owner |
|---------|--------|
| OAuth, token refresh UI, device provisioning | Web app |
| Meta `/me` cron fetch, Influx history, MQTT to hardware | proofmqtt |
| Dashboard cache (`Social.followerCount`) | Web app (via webhook + read API) |
| Device milestone celebrations (50 / 100) | proofmqtt (MQTT envelope) |

Meta Graph calls for follower count happen only on: OAuth exchange, connect-time seed, token refresh, and inside proofmqtt cron/on-demand fetch. The web app never calls Meta on page load.

## Environment variables

| Variable | Repo | Purpose |
|----------|------|---------|
| `METRICS_API_URL` | web app | Base URL for metrics read API (defaults to `MQTT_SERVER_URL`) |
| `WEBAPP_WEBHOOK_URL` | proofmqtt | Full URL to web app `POST /api/internal/instagram/follower-update` |
| `WEBHOOK_SECRET` | both | Shared secret; proofmqtt sends `x-webhook-secret` header |
| `AUTH_SECRET` | both | HS256 JWT for service-to-service auth on read API |
| `CONNECTIONS_VALIDATE_API_KEY` | both | `POST /api/v1/connections/validate` fan-out on connect/disconnect |

### proofmqtt polling / rate limits

| Variable | Default | Purpose |
|----------|---------|---------|
| `IG_POLL_BACKGROUND_INTERVAL_MS` | `60000` | Cron interval (1/min) |
| `IG_ACCOUNT_CRON_CAP_PER_HR` | `60` | Scheduled fetches per IG account per hour |
| `IG_ACCOUNT_ON_DEMAND_CAP_PER_HR` | `30` | Connect/attention/on-demand cap per account |
| `IG_ACCOUNT_TOTAL_CAP_PER_HR` | `200` | Combined Meta budget per account |

Account-level cache: skip Meta if last fetch **<60s** ago.

## Read API (proofmqtt → web app)

Auth: `Authorization: Bearer <service JWT>` (same `AUTH_SECRET` as provisioning).

### `GET /api/v1/instagram/metrics/current`

Query: `userId` or `socialId` (JWT subject must match `userId` when provided).

Response `200`:

```json
{
  "followerCount": 501,
  "lastSyncedAt": "2026-08-25T12:00:00.000Z",
  "source": "mongo"
}
```

`source`: `"mongo"` | `"influx"` | `"live"` (on-demand refresh when stale >60s).

### `GET /api/v1/instagram/metrics/history`

Query: `userId` or `socialId`, `range=30d|90d`.

Response `200`:

```json
{
  "series": [{ "t": "2026-08-01T00:00:00.000Z", "count": 480 }],
  "totalGrowth": 21,
  "lastSyncAt": "2026-08-25T12:00:00.000Z"
}
```

## Webhook push (proofmqtt → web app)

**Change only** — not sent on every cron tick.

`POST {WEBAPP_URL}/api/internal/instagram/follower-update`

Headers:

```
Content-Type: application/json
x-webhook-secret: <WEBHOOK_SECRET>
```

Body:

```json
{
  "userId": "<mongo User _id>",
  "socialId": "<mongo Social _id>",
  "followerCount": 501,
  "previousCount": 500,
  "syncedAt": "2026-08-25T12:00:00.000Z"
}
```

Web app receiver: `app/api/internal/instagram/follower-update/route.ts`  
Web app client: `lib/proof-server/instagram-metrics.ts`

## Lifecycle events

### Connect

Web app calls `POST /api/v1/connections/validate` with `{ event: "social.connected", userId, provider: "instagram" }`.

proofmqtt:

1. Rebuilds integration cache from shared Mongo
2. Queues immediate IG fetch for all active user devices (`trigger=connect`)
3. Optional baseline: `POST /api/v1/integrations/connect` returns `{ followerCount, lastSyncedAt }` for Instagram

### Disconnect

Web app calls `connections/validate` with `social.disconnected` or `POST /api/v1/integrations/disconnect` (Bearer JWT).

proofmqtt purges account fetch cache, clears device follower runtime fields, and removes devices from IG priority queue.

### 401 / re-auth

Graph OAuth errors set `Social.needsReauth=true` and apply account backoff. Disconnected accounts are skipped by the background poller.

## Rate limit summary

| Source | Calls/hr/account |
|--------|-------------------|
| Cron (1/min) | 60 |
| On-demand (capped) | ≤30 |
| OAuth + refresh | headroom |
| Meta limit | 200 |

## Manual QA checklist

1. Connect IG (basic scope only) → dashboard count visible immediately
2. Follow from another account → dashboard updates within ~1–2 min without user action
3. Same follow → physical PROOF device updates via MQTT (not browser URL)
4. Seed account at 49 → one follow → 50 celebration on device + dashboard
5. Stop proofmqtt → dashboard shows last-known + last synced (no crash)
6. Disconnect IG → polling stops; reconnect restores cron
