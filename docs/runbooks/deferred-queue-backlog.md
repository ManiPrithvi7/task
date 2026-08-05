# Deferred queue backlog / stale drops

## Log contract (alert-ready)

`[DEFERRED_WORK] Drain complete` fields:

| Field | Meaning |
|-------|---------|
| `pending` / `pendingAfter` | Queue depth before/after drain |
| `processed` | Successfully handled |
| `failed` | Handler threw |
| `skippedStale` | Dropped after 30s TTL |
| `requeued` | Failed items retried once |
| `rearmed` | Another drain scheduled or needed |

**Alert:** rising `skippedStale` or `failed` under reconnect storms.

## Policy (Phase 0)

- Stale TTL 30s accepted; re-enqueue refreshes `enqueuedAt`
- Failures retry once then drop
- Handler bounded by `DEFERRED_WORK_HANDLER_TIMEOUT_MS` (default 30s); a hung handler counts failed and retries once
- Coordinator-not-ready throws (counts failed / retry), not silent success
- Concurrent `processAll` while a drain is in flight is a no-op (no log, no re-arm); the in-flight drain owns the re-arm
- In-memory queue: lost on restart / not shared across instances (pilot limit)

## Rollback

Set `DEFERRED_WORK_REARM=false` to disable post-drain re-arm.

## Capacity

Manual reconnect-storm checks: [docs/CAPACITY.md](../CAPACITY.md). Broker E2E remains under `scripts/ota-e2e/`.
