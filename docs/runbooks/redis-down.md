# Redis down

## Symptoms

- Recovery reissue returns `REDIS_UNAVAILABLE` (503)
- Logs: `[WEBHOOK_DEDUPE] Redis unavailable` with `dedupe_fail_open: true`
- Provisioning tokens may fall back to in-memory (non-prod) or fail features that require Redis

## Impact (pilot)

- GMB/OTA webhook dedupe fails open (duplicate processing possible) — accepted pilot risk; alert on rising `dedupe_fail_open`
- Deferred OTA/connect queue is **in-memory** and independent of Redis, but tokens/sessions that use Redis break

## Actions

1. Check Upstash / `REDIS_URL` TLS endpoint and Railway private networking.
2. Confirm `rediss://` and credentials.
3. After Redis returns: monitor for duplicate webhook side effects; re-issue recovery tokens if needed.

## Related

- [docs/REDIS_CONNECTION_FIX.md](../REDIS_CONNECTION_FIX.md)
- [deferred-queue-backlog.md](deferred-queue-backlog.md)
