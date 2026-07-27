# Phase 0 — Production Hardening Assessment

**Date:** 2026-07-27  
**Scope:** Re-verify Appendix C baseline; lock decisions before Phase 1+ edits.

## Baseline re-verify

| Claim (Appendix C) | Status |
|--------------------|--------|
| Prod JWT / Redis / `TEST_OTA` guards | Confirmed (`validateConfig`, `assertTestOtaAllowed`) |
| caService null fail-closed on MQTT gate | Confirmed (`deviceProvisioningGate.ts`) |
| mTLS fingerprint bind; DB blip → 503 | Confirmed (`mtlsAuth.ts`) |
| Deferred OTA queue + concurrency | Confirmed; gaps remain (below) |
| Bootstrap split | Confirmed (`src/bootstrap/`) |
| E2E harness (7 HTTP flows) | Confirmed; **runs in CI** (`bun run test:e2e`) |
| `validate-env.ts` + CONFIG_MATRIX | Confirmed |

## Production readiness scores (post re-verify)

| Dimension | Score | Notes |
|-----------|-------|-------|
| Security | B | Guards in place; webhook timing safe compare, GMB dedupe fail-open (pilot risk), admin audit gaps |
| Reliability | B− | Deferred queue re-arm + retry-on-failure; explicit drain counters; in-memory pilot queue + stale drop remain |
| Observability | B− | Runbooks + log contract (alert-ready) for deferred drain + dedupe_fail_open; structured counters in drain logs |
| Operability | B | Runbooks added; CI now validates prod-shaped fixture (`validate-env`) and runs `test:e2e`; Bun pin aligned |
| Testability | B− | Unit solid on critical paths; E2E coverage expanded + included in CI; misconfig boot suite present |

## Logic risks (inventory)

1. Deferred single-flight stranding (`deferredDeviceWork.processAll`)
2. Failed items dropped (no requeue)
3. Coordinator-not-ready returns without throw → counted `processed`
4. 30s stale under storm
5. OTA webhook non-constant-time bearer compare
6. GMB Redis dedupe fail-open
7. MQTT cert lookup Mongo error → `null` (looks unprovisioned)
8. Slot query: mTLS allows missing `slot`; CA query requires `$in`
9. MQTT ingress buffer max 100, drop-oldest during warmup
10. In-memory deferred queue lost on restart / multi-instance
11. Admin halt audited as `OTA_PUSH_SENT`; mark-retryable/retry unaudited
12. Implicit OTA success semantics — verify vs `SERVER_OTA_REQUIREMENTS.md` in Phase 1

## Error-code inventory (auth / webhooks)

| Code | HTTP | Surface |
|------|------|---------|
| `MTLS_REQUIRED` | 401 | mTLS middleware |
| `CERT_LOOKUP_UNAVAILABLE` | 503 | mTLS middleware |
| `CERT_NOT_ACTIVE` | 403 | mTLS middleware |
| `CERT_FINGERPRINT_MISMATCH` | 403 | mTLS middleware |
| `WEBHOOK_UNAUTHORIZED` | 401 | OTA webhooks |
| `AUTH_TOKEN_MISSING` / `AUTH_TOKEN_INVALID` | 401 | Admin / provisioning |
| `ADMIN_ACCESS_REQUIRED` | 403 | OTA admin |
| `RECOVERY_TOKEN_REQUIRED` | 400 | Lifecycle reissue |
| `REDIS_UNAVAILABLE` | 503 | Recovery when Redis down |
| `IP_RATE_LIMITED` | 429 | Lifecycle |

## Locked decisions (Phase 0 addendum)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Stale-drop under storms | **Accept 30s TTL + metric/alert**; re-enqueue refreshes `enqueuedAt` (existing dedupe) | Avoid unbounded backlog; alert on rising `skippedStale` |
| Failed deferred work | **Retry once (N=1)** then drop + metric | Covers blips without infinite loops |
| E2E mismatch/503 | **Add to E2E** with mock isolation | Reduce false confidence from unit-only |
| CI validate-env | **Yes — checked-in prod-shaped fixture** (fake secrets) | Empty CI env always fails otherwise |
| Multi-instance deferred queue | **Pilot limitation OK** — document; Redis-backed = post-pilot | Matches PILOT exceptions posture |

## GMB dedupe fail-open

**Accepted pilot risk** with structured warn + metric field `dedupe_fail_open=true`. Fail-closed deferred to post-pilot (owner: platform). Documented in uncensored / runbooks.

## Execution order

Phase 0 (this doc) → P0 deferred + misconfig → stabilize/deepen E2E → CI gate → P1 webhook/cert/obs/audit → P2 runbooks/ops.
