# stimulate/ — TEMP Testing-Phase (in-process)

Allowlisted IG follower / GMB review ramps run **inside the main MQTT server** when `STIMULATE_DEVICE` is set. No separate process or `bun run stimulate`.

## Cloud / local config

```bash
STIMULATE_DEVICE="DEVICE-19"
STIMULATE_PLATFORMS="instagram,gmb"
STIMULATE_INTERVAL_MS=30000
STIMULATE_STEP=1
STIMULATE_IG_TARGET=500
STIMULATE_GMB_TARGET=100
# Optional: also drop Redis stim locks on boot
# STIMULATE_CLEAR=1
```

Then start the server as usual (`bun run start` / `bun run dev`). Look for:

```text
[STIM] ===== Starting in-process stimulate service =====
[STIM_IG] Published ...
```

Main-app live IG poller / connect refresh / GMB publish skip those device IDs.

## Behaviour

- **Credentials ignored** — stim always publishes synthetic ramps from 0 (IG and GMB), whether or not social is linked.
- **In-memory progress only** — no `data/stimulate/` files. Server restart → ramp from 0 again.
- **Device `/active` reset** — reconnecting an allowlisted device clears progress and restarts both platform loops from 0.
- When target is reached, that platform **stops** (no repeated same-message publishes). Reconnect to ramp again.
- Topics: `{topicRoot}/{deviceId}/instagram` and `{topicRoot}/{deviceId}/gmb`.
- Same v1.2 celebration payloads as production (mini/mega boundaries apply).

## Removal Checklist (after testing)

1. Unset `STIMULATE_*` from `.env` / cloud env.
2. Delete `stimulate/` (and any leftover `data/stimulate/`).
3. Delete [`src/services/stimulateService.ts`](../src/services/stimulateService.ts) and remove start/stop + `/active` hook from [`src/app.ts`](../src/app.ts).
4. Revert TEMP hooks in Instagram/GMB/StatsPublisher + delete `src/utils/stimulateAllowlist.ts`.
5. Remove `STIMULATE_*` from `.env.example`.
6. `graphify update .`
