# Loyalty spin — cross-service contract

Source of truth for **statsnapp** (Next.js web app) and **proofmqtt** (this Node server). Firmware MQTT topics and presence are defined here; older handoff drafts that mention `device/{id}/command` or `GET /api/v1/devices/{id}/status` are **wrong**.

| Concern | Owner |
|---------|--------|
| Weighted pick, prize catalog, Prisma `LoyaltySpin` write | statsnapp |
| Session, browser WSS, MQTT publish/ack, Node `loyalty_spins` lifecycle | proofmqtt |
| Reel animation on device | ESP32 firmware |
| Reward issuance / cashier redemption | statsnapp (after Node reaches a terminal display outcome) |

---

## 1. MQTT and presence (do not invent a second subsystem)

| Direction | Topic | QoS | retain | Payload `type` |
|-----------|-------|-----|--------|----------------|
| Node → ESP32 | `{MQTT_TOPIC_ROOT}/{deviceId}/loyalty` | 2 | false | `spin-start` |
| ESP32 → Node | `{MQTT_TOPIC_ROOT}/{deviceId}/ack` | 1 | false | `spin-ack` |

Default root is `proof.mqtt` (same as OTA/screens). Example: `proof.mqtt/DEVICE-17/loyalty` and `proof.mqtt/DEVICE-17/ack`. Loyalty never uses `{MQTT_TOPIC_ROOT}/{deviceId}/cmd`. Node ignores non-`spin-ack` payloads on `/ack` so OTA rollback handshake can share that topic. Publish ack **immediately after accepting a valid `spin-start`**, before animation completes.

**Device online** for join: Node `ActiveDeviceCache.getActive(deviceId)` (MQTT `/active` + LWT). There is no `GET /api/v1/devices/{clientId}/status`.

---

## 2. Call sequence (strict)

```text
1. Browser  → POST https://server.withproof.io/loyalty/join           { deviceId }
2. Browser  → WSS  wss://server.withproof.io/loyalty/realtime?sessionId=
3. Browser  waits for WS event loyalty.session.ready
4. Browser  → POST statsnapp /api/loyalty/spin   { sessionId, deviceId, idempotencyKey }
5. statsnapp picks result, writes Prisma, POST Node /loyalty/spin with X-Loyalty-Key + result
6. Node     → MQTT spin-start (includes result + issuedAt/expiresAt)
7. ESP32    → MQTT spin-ack (immediately after accepting start; before animation completes)
8. Node     → WS loyalty.spin.started { spinId, startedAt, ttlMs, revealAt, serverNow }  (no result)
9. Browser  reveals locally at revealAt using result from step 5
10. Optional GET Node /loyalty/spin/:spinId  (poll fallback / reconciliation)
```

Browser **never** POSTs `/loyalty/spin` on Node. That is server-to-server only.

---

## 3. Web app (statsnapp) responsibilities

### 3.1 Public page `/linktree/{deviceId}`

| Step | What the page does | How to process the payload |
|------|--------------------|----------------------------|
| Join | `POST /loyalty/join` `{ "deviceId" }` | **201:** store `sessionId`, `expiresAt`. Open WSS. Enable spin only after `loyalty.session.ready`. **409 `ACTIVE_SESSION_EXISTS`:** show “Someone else is spinning”, retry after delay. **503 `DEVICE_OFFLINE`:** show “Display offline”, do **not** open WSS. **400/404:** invalid or unknown device. |
| WSS | `wss://server.withproof.io/loyalty/realtime?sessionId=ls_...` | On open, wait for `{ "event": "loyalty.session.ready", "sessionId", "deviceId" }`. Mismatch → abort. |
| Spin tap | Disable button. Mint a **new** `idempotencyKey` (UUID) **per tap**. `POST /api/loyalty/spin` (BFF) with `{ sessionId, deviceId, idempotencyKey }`. | Do not send `result` from the browser. |
| BFF 200 | Body includes `{ spinId, status, result }` | **Buffer `result` in memory. Do not render digits until `loyalty.spin.started`.** If MQTT is lost and you reveal from the BFF body anyway, the phone shows a win the machine never displayed (phantom win). |
| Session idle / `loyalty.session.error` / close `4401` | Session TTL is 45s from `createdAt` even if WSS is open and no spin started | **Auto-rejoin:** `POST /loyalty/join` again, new `sessionId`, reopen WSS. Never reuse the expired `sessionId`. |
| `loyalty.spin.started` | `{ spinId, startedAt, ttlMs, revealAt, serverNow }` all times **ISO 8601** | `offsetMs = Date.parse(serverNow) - Date.now()`. Schedule reveal at `Date.parse(revealAt) - offsetMs` (equivalent: `now + (revealAt - serverNow)`). Play animation. **Do not use the phone clock against `revealAt` without `serverNow`.** |
| Reveal | At scheduled time | Render buffered `result.digits`, `result.value`, `result.reward`. Close WSS. |
| Late WS | If `revealAt` already passed when `started` arrives | Skip animation; reveal immediately from buffer. |
| Watchdog | No `loyalty.spin.started` within **6s** of BFF 200 | Poll `GET /loyalty/spin/:spinId` every 500ms until terminal. If GET includes `result` and `ackReceivedAt` equivalent (`status` ≥ `ack_received`), reveal. |
| `loyalty.spin.failed` | `{ spinId, code, message }` | Show error, stop animation, mint **new** idempotencyKey if user retries. Close or keep WS per UX; session may still be `READY`. |
| `loyalty.session.error` | then socket close (`4401`) | Re-join. Do not reuse old `sessionId`. |
| WS drop mid-spin | | Poll GET every 500ms until terminal. |
| Join/WSS CORS | Browser origin must match Node allowlist | `withproof.io` + `CORS_ALLOWED_ORIGINS` + `LOYALTY_PREVIEW_ORIGIN_PATTERN` (not `*.vercel.app`). |

### 3.2 BFF `POST /api/loyalty/spin` (statsnapp server)

Process **in this order**. Do not skip the Node call after a Prisma write without a failure path.

1. Validate `sessionId`, `deviceId`, `idempotencyKey` from the browser (no `result`).
2. Run weighted picker against `LoyaltyRewardConfig`. Produce `result = { digits: [n,n,n], value: string, reward: string }` (`digits` length 3, each 0–9).
3. Allocate `spinId` (`spin_…`). Write Prisma `LoyaltySpin` (`PENDING` / equivalent) **before** calling Node.
4. `POST {LOYALTY_NODE_URL}/loyalty/spin` with headers `Content-Type: application/json`, **`X-Loyalty-Key: {LOYALTY_SPIN_SECRET}`** (same secret as Node). Body:

```json
{
  "sessionId": "ls_...",
  "idempotencyKey": "uuid-per-tap",
  "spinId": "spin_...",
  "result": { "digits": [7, 7, 7], "value": "777", "reward": "Free Item" }
}
```

5. **Map Node responses to the browser:**

| Node status | statsnapp action | Browser body |
|-------------|------------------|--------------|
| **200** `{ spinId, status: "command_published", result }` | Keep Prisma row pending-display. Return **200** to browser with `spinId`, `status`, **`result`**. | Phone buffers `result`; waits for WS timing. |
| **400** bad result | Should not happen if picker is correct. Mark Prisma `FAILED`. | 400, no animation. |
| **401** missing/wrong key | Ops/config error. Mark Prisma `FAILED`. Log; do not retry blindly. | 503 generic. |
| **409 `LOYALTY_SESSION_NOT_READY`** | Mark Prisma `FAILED` or retry once after client reconnects WS. | Tell client to reconnect WSS / re-join. |
| **409 `SPIN_IN_PROGRESS`** | Device busy. Do not invent a new prize. | “Spin in progress”. |
| **409 `SPIN_ID_CONFLICT`** | Same `spinId` reused with different result — bug. Mark failed. | 409. |
| **409 `ACTIVE_SESSION_EXISTS`** | N/A on spin. | — |
| **410** session expired | Mark Prisma `FAILED`. | Re-join. |
| **503 `DEVICE_OFFLINE` / `MQTT_PUBLISH_FAILED`** | Mark Prisma `FAILED`. | “Display unavailable”, retry later. |
| Network / timeout | Mark Prisma `FAILED`. | 503. **Do not** leave Prisma as “won” if Node never accepted. |

Idempotent Node 200 (same `sessionId` + `idempotencyKey`): return the **same** `result` Node stored. Do not re-roll.

**Fresh `idempotencyKey` per tap.** Reusing a key after Node `FAILED` (within 60s) returns the **dead** spin — the UI must mint a new key on retry.

### 3.3 Reconciliation (Prisma vs Node `loyalty_spins`)

Shared key: `spinId`. Node is authority for **device lifecycle**; statsnapp is authority for **reward issuance**.

Until a Node→statsnapp webhook exists:

- After 200 from Node, treat Prisma as `AWAITING_DISPLAY`.
- Poll `GET /loyalty/spin/:spinId` every **2s** for at most **20s** (or until terminal). Cadence is statsnapp-owned; Node has no callback in v1.
- Alert (log/pager) if a row stays `AWAITING_DISPLAY` after 20s of failed or non-terminal polls — do not auto-issue the reward.
- Node `status` `failed` → Prisma `FAILED`, do **not** issue reward.
- Node `completed` / `revealed` (and GET includes `result`) → Prisma `DISPLAYED` / issue per product rules.
- Prisma written, Node never 200 → Prisma `FAILED` immediately (step 5).

### 3.4 What the web app must **not** do

- Pick or override `result` in the browser.
- Call Node `/loyalty/spin` from the browser (prize injection).
- Open WebSocket to the ESP32.
- Schedule reveal with `Date.now()` vs `revealAt` without applying `serverNow`.
- Reuse `idempotencyKey` across retries after failure.
- Treat Prisma “picker succeeded” as a win if Node returned 4xx/5xx.

---

## 4. Payloads the web app must parse

### Join 201

```json
{ "sessionId": "ls_...", "deviceId": "DEVICE-17", "expiresAt": "2026-08-27T17:00:45.000Z" }
```

Session dies 45s after `createdAt` if no spin starts (even if WSS is open). Frontend must re-join.

### Node spin 200 (BFF forwards to browser)

```json
{
  "spinId": "spin_abc123",
  "status": "command_published",
  "result": { "digits": [7, 7, 7], "value": "777", "reward": "Free Item" }
}
```

### WS `loyalty.spin.started` (timing only)

```json
{
  "event": "loyalty.spin.started",
  "spinId": "spin_abc123",
  "startedAt": "2026-08-27T17:00:01.000Z",
  "ttlMs": 5000,
  "revealAt": "2026-08-27T17:00:06.000Z",
  "serverNow": "2026-08-27T17:00:01.050Z"
}
```

`revealAt` is **server** `ackReceivedAt + ttlMs`. `startedAt` is the device echo (telemetry).

### WS `loyalty.spin.failed`

```json
{ "event": "loyalty.spin.failed", "spinId": "spin_abc123", "code": "ACK_TIMEOUT", "message": "Device did not acknowledge spin" }
```

### GET `/loyalty/spin/:spinId`

`result` is present **only after ack**. Use for poll fallback, not as the happy-path reveal (result already arrived in spin 200).

### Errors (all Node loyalty REST)

```json
{ "code": "LOYALTY_SESSION_NOT_READY", "message": "WebSocket is not connected for this session" }
```

---

## 5. Node command payload (firmware; web app does not send this)

Published on `{MQTT_TOPIC_ROOT}/{deviceId}/loyalty` after a successful spin persist:

```json
{
  "type": "spin-start",
  "spinId": "spin_abc123",
  "result": { "digits": [7, 7, 7], "value": "777", "reward": "Free Item" },
  "ttlMs": 5000,
  "reels": 3,
  "symbols": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  "issuedAt": "2026-08-27T17:00:00.000Z",
  "expiresAt": "2026-08-27T17:00:10.000Z"
}
```

Firmware **must discard** if device clock `now > expiresAt` (stale queue after reconnect).

**Deployment gate:** flash firmware that subscribes `{MQTT_TOPIC_ROOT}/{id}/loyalty` **before** staging drills. Builds still listening on `device/{id}/loyalty` or `{id}/command` will time out every spin at 5s. OTA command topic `{MQTT_TOPIC_ROOT}/{id}/cmd` is unrelated.

Device ack on `{MQTT_TOPIC_ROOT}/{deviceId}/ack` (QoS 1, retain false), immediately after accepting a valid `spin-start`:

```json
{
  "type": "spin-ack",
  "spinId": "spin_abc123",
  "startedAt": "2026-08-27T17:00:01.234Z",
  "ttlMs": 5000
}
```

---

## 6. Env (both sides)

| Variable | statsnapp | proofmqtt |
|----------|-----------|-----------|
| `LOYALTY_SPIN_SECRET` | BFF `X-Loyalty-Key` | Required in staging/prod |
| `LOYALTY_NODE_URL` | `https://server.withproof.io` | — |
| `LOYALTY_PREVIEW_ORIGIN_PATTERN` | — | Regex for Vercel previews, not `*.vercel.app` |

---

## 7. Single-instance note

Node `activeConnections` is in-memory (one process). Redis pub/sub is future work. After a process restart, browsers must reconnect WSS (server pings every 30s so zombies drop). The Mongo sweeper runs **immediately on boot** as well as on a 1s/5s tick: stale `CREATED` spins (crash between insert and MQTT) fail after ack timeout; `ACK_RECEIVED` past `revealAt` becomes `REVEALED`/`COMPLETED`; `SPINNING` sessions with no in-flight spin return to `READY` or `EXPIRED`.

## 8. Staging sign-off

- [ ] Forged `POST /loyalty/spin` without `X-Loyalty-Key` → 401
- [ ] WSS upgrade from a disallowed `Origin` → rejected
- [ ] Two tabs, same device → second join 409
- [ ] MQTT broker restart mid-spin → ack still processed
- [ ] `kill -9` Node mid-spin → sweeper unlocks device within ~5s of boot
- [ ] Phone clock ±3s (or set to 2020) → reveal still syncs via `serverNow`
- [ ] Network drop mid-spin → `loyalty.spin.failed` or GET poll recovers
- [ ] Firmware on the device is subscribed to `{MQTT_TOPIC_ROOT}/{id}/loyalty` (default `proof.mqtt/{id}/loyalty`, not `device/{id}/loyalty` or `/command`)

