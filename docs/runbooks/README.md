# Runbooks — ProofMQTT operations

Index of incident / ops procedures. Alert on rising `skippedStale` / `failed` / `dedupe_fail_open` in structured logs.

| Runbook | Path |
|---------|------|
| Boot failure (incl. Influx) | [boot-failure.md](boot-failure.md) |
| Redis down | [redis-down.md](redis-down.md) |
| OTA webhook reject | [ota-webhook-reject.md](ota-webhook-reject.md) |
| Cert lookup 503 | [cert-lookup-503.md](cert-lookup-503.md) |
| Secret rotation (JWT / OTA webhook) | [secret-rotation.md](secret-rotation.md) |
| Deferred queue backlog / stale | [deferred-queue-backlog.md](deferred-queue-backlog.md) |

See also [docs/CAPACITY.md](../CAPACITY.md) for reconnect-storm capacity notes (manual/scheduled; not CI).
