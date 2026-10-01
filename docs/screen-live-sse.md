# Screen live — SSE contract

Source of truth for **statsnapp** (Next.js) and **proofmqtt** (this Node server). MQTT to the physical display is unchanged. Loyalty stays on `WSS /loyalty/realtime`.

| Concern | Owner |
|---------|--------|
| Instagram fetch, connect burst, MQTT screen publish | proofmqtt |
| Browser fanout during the connect burst | proofmqtt `GET /screen/realtime` |
| Dashboard tiles | statsnapp |

The feed exists only for an allowlisted device during the connect burst (about 10s between counts, 90s window). It is not a standing dashboard socket.

---

## 1. Open the stream

```text
GET https://server.withproof.io/screen/realtime?deviceId={deviceId}&token={jwt}
```

Build the origin with `getMqttServerOrigin()`. Keep `http` / `https`. Do not flip the scheme to `ws`.

| Query | Required | Meaning |
|-------|----------|---------|
| `deviceId` | yes | Provisioned device id, normalized the same way as today |
| `token` | yes | Dashboard session JWT (HS256). `sub` / `userId` is the business id |

`EventSource` cannot set `Authorization`. The JWT goes in the query string. The device id is the subscription key, not a credential. A request that sends the device id as `token` is rejected.

The token is checked once, when the stream opens. Later `screen.count` frames are writes on that response. The JWT business id must equal the device's `businessId`.

Browser `Origin` must pass the loyalty allowlist (`withproof.io`, `CORS_ALLOWED_ORIGINS`, `LOYALTY_PREVIEW_ORIGIN_PATTERN`).

Response headers on success:

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache, no-transform`
- `X-Accel-Buffering: no`

Do not send `Last-Event-ID`. Each connect sends a fresh snapshot of the cached counts.

---

## 2. Events

Frames use a named SSE event. The JSON body still includes `event`.

```text
event: screen.count
data: {"event":"screen.count","deviceId":"274968B43A1D","followers":42,"at":"2026-10-01T06:30:00.000Z"}

```

| SSE event | When | JSON |
|-----------|------|------|
| `screen.count` | Snapshot on open, then each change | `deviceId`, `at` (ISO-8601). `followers` and `reviews` are optional and independent. `followers: 0` is a real count. |
| `screen.burst.ended` | Burst window closed | `{ "event": "screen.burst.ended", "deviceId" }` |

A comment line (`: ping`) may arrive about every 15s. Ignore it.

---

## 3. Client

Open only while the device page is in the connect burst (`connectGeneration > 0` and the device is allowlisted). Fetch the session JWT from `/api/auth/token`, then:

```javascript
const es = new EventSource(url);
es.addEventListener("screen.count", (ev) => {
  const msg = JSON.parse(ev.data);
  // ignore a frame whose deviceId is not this page
  // apply followers / reviews only when the field is a number
});
es.addEventListener("screen.burst.ended", () => {
  es.close();
});
es.onerror = () => {
  if (es.readyState === EventSource.CLOSED) {
    // 403 before any bytes. EventSource stops. Do not open another one.
    // The 403 body is not visible here. Keep the last counts.
  }
  // readyState CONNECTING: a dropped 200 stream is reconnecting. Do nothing.
};
```

On unmount, close the `EventSource` and remember that this client closed it, so `onerror` does not treat that close as a 403.

| HTTP | Meaning | What the page does |
|------|---------|--------------------|
| 200 stream | Authorized and inside the burst | Apply `screen.count`. On `screen.burst.ended`, close and stop. |
| 403 | Not allowlisted, burst finished, business mismatch, or origin rejected | Do not retry. Keep the last counts. |
| 429 | More than 10 connection attempts per minute from this IP | Do not loop. |

`onerror` does not include the 403 message (`device not allowlisted`, `connect burst finished`, `business mismatch`, `origin not allowed`, `origin required`). Use `fetch()` and read the body only if the UI must show that string. Retry only when a 200 stream drops, not after a non-200.

A reconnect inside the window receives a new snapshot. If both numbers are unchanged, leave React state as it is. A patch that sets only `followers` must leave the current review count in place.
