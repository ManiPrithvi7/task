# stimulate/ — TEMP Testing-Phase (in-process)

Allowlisted IG follower / GMB review ramps run **inside the main MQTT server** when `STIMULATE_DEVICE` is set. No separate process or `bun run stimulate`.

## Cloud / local config

```bash
STIMULATE_DEVICE="DEVICE-15"
STIMULATE_PLATFORMS="instagram,gmb"
STIMULATE_INTERVAL_MS=30000
STIMULATE_STEP=1
STIMULATE_IG_TARGET=500
STIMULATE_GMB_TARGET=100
# Optional: clear locks + caches on next boot, then leave unset
# STIMULATE_CLEAR=1
```

Then start the server as usual (`bun run start` / `bun run dev`). Look for:

```text
[STIM] ===== Starting in-process stimulate service =====
[STIM_IG] Published ...
```

Main-app live IG poller / connect refresh / GMB publish skip those device IDs.

## Synthetic mode (no IG/GMB connection)

If a allowlisted device has **no Instagram or GMB social linked** in Mongo, stimulate still publishes production-shaped MQTT envelopes:

- Baseline count starts at **0** and ramps via `STIMULATE_STEP` toward `STIMULATE_IG_TARGET` / `STIMULATE_GMB_TARGET`.
- Topics: `{topicRoot}/{deviceId}/instagram` and `{topicRoot}/{deviceId}/gmb`.
- Same v1.2 celebration payloads as connected devices (mini/mega boundaries apply).
- IG/GMB are independent: one platform can be synthetic while the other uses live API/Mongo counts.
- If IG **is** connected but the Graph API fetch fails, that tick retries (no synthetic fallback for API errors).

Look for `[STIM_IG] No Instagram connection — synthetic ramp from 0` or `[STIM_GMB] No GMB connection — synthetic ramp from 0` in logs.

## Reset after a completed ramp

Set `STIMULATE_CLEAR=1`, restart once, then remove the flag and restart again to ramp from live count.

## Removal Checklist (after testing)

1. Unset `STIMULATE_*` from `.env` / cloud env.
2. Delete `stimulate/` and `data/stimulate/`.
3. Delete [`src/services/stimulateService.ts`](../src/services/stimulateService.ts) and remove start/stop from [`src/app.ts`](../src/app.ts).
4. Revert TEMP hooks in Instagram/GMB/StatsPublisher + delete `src/utils/stimulateAllowlist.ts`.
5. Remove `STIMULATE_*` from `.env.example`.
6. `graphify update .`
