# Dead Code & Irrelevant File Cleanup Plan

> **Status:** DRAFT — review before executing. No changes have been made.
> **Scope:** `proofmqtt` application source, config, scripts, tests, and committed artifacts.
> **Verification baseline:** `bun run check` (lint + typecheck + build + unit tests) and `bun run test:e2e`.

---

## 1. Summary of findings

| Category | Count | Notes |
|---|---|---|
| A. Dead source files (no production importer) | ~14 files | Safe to delete, confirm each first |
| B. Committed private/runtime material | ~9 files | Security + hygiene, remove from git tracking |
| C. Generated / build artifacts tracked in git | ~8 files | Should be gitignored + untracked |
| D. Stale tooling / config | ~5 files | Jest remnants, duplicate Railway config |
| E. Duplicate / orphan docs | ~2 files + list | Exact duplicates, unreferenced docs |
| F. Ops scripts not wired to package.json / CI | ~16 scripts | Review, keep the ones actively used |

---

## 2. A. Dead source files — safe to remove

These files exist under `src/` but have **no importer anywhere in the codebase**
(grepped across `src/`, `tests/`, `scripts/`, `stimulate/`).

| # | File | Why it is dead | Impact if removed |
|---|---|---|---|
| 1 | `src/init.ts` | Empty `class Initializer {}` — no logic, never imported | None |
| 2 | `src/config/promotionConfig.ts` | `resolvePromotionInvalidateApiKey()` never imported (promotion invalidation key unused) | None |
| 3 | `src/services/metrics/processDailyMetrics.ts` | `processDailyMetrics()` never imported | None |
| 4 | `src/services/metrics/dailyMetricsLua.ts` | Only imported by `processDailyMetrics.ts` (#3) | None |
| 5 | `src/services/metrics/helpers.ts` | Only imported by `processDailyMetrics.ts` (#3) and `tests/unit/services/metrics/helpers.test.ts` — remove the test too | None |
| 6 | `src/types/index.ts` | Interfaces (`DeviceInfo`, `SessionInfo`, …) never imported; superseded by per-domain types | None |
| 7 | `src/types/acl.ts` | Never imported; duplicates `DeviceACL`/`DeviceTier` already defined in `src/models/DeviceACL.ts` | None |
| 8 | `src/services/googleBusiness/googleBusinessApi.ts` | Only imported by `tests/unit/services/googleBusinessApi.test.ts`; production code uses `googleBusinessOAuth` + `gmbConnectPull` instead | Remove test as well |
| 9 | `src/models/Redemption.ts` | Re-exported in `models/index.ts` but the export is never consumed anywhere | None |
| 10 | `src/models/ShopifyProfile.ts` | Same as #9 — re-exported, never consumed | None |
| 11 | `src/models/SquareProfile.ts` | Same as #9 — re-exported, never consumed | None |
| 12 | `src/models/DeviceACL.ts` | Re-exported (`DeviceACL`, `DeviceTier`) in `models/index.ts`; no consumer in `src/`, `tests/`, or `scripts/` | Verify no route/ACL code expects it |
| 13 | `src/webhooks/webhookHandlerError.ts` | `respondWebhookHandlerError()` has zero callers | None |
| 14 | `src/webhooks/webhookHandlerResponse.ts` | `finishWebhookAck()` has zero callers | None |

### 2.1 Dead exports to prune (files stay, exports go)

- `src/models/index.ts` — remove the re-export lines for `Redemption`, `ShopifyProfile`, `SquareProfile`, and `DeviceACL` after confirming no consumers (lines 15–16, 24–28, 41–42).

---

## 3. B. Committed private / runtime material — remove from git

Security issue first, then stale runtime state.

| # | File | Problem | Action |
|---|---|---|---|
| 1 | `scripts/ota-e2e/keys/ota_private.pem` | **Private signing key committed to git** | Remove from repo; regenerate for e2e only, never commit |
| 2 | `scripts/ota-e2e/keys/ota_public.pem` | Public key committed (less severe, but e2e-only material) | Remove; generate in the e2e script (`scripts/ota-e2e/generate-keys.sh` already exists) |
| 3 | `data/.mqtt-tls/ca.pem` | CA certificate committed | Remove from tracking; CA material lives in env/base64 injection per `.gitignore` convention |
| 4 | `service.crt.b64` | Empty (0 bytes), stale placeholder | Delete |
| 5 | `broker.csr` | Stale CSR artifact | Delete |
| 6 | `broker/certs/broker.csr` | Stale CSR artifact | Delete (and see §8 — `broker/` dir becomes empty) |
| 7 | `data/ca/audit.log` | Runtime CA audit log committed | Add `data/ca/*.log` to `.gitignore`; untrack |
| 8 | `data/ca/root-ca.srl` | openssl serial-file state committed | Untrack; gitignore |
| 9 | `data/ESP32S3_DWIN_MVP_v101.ino.bin` | 1.2 MB firmware binary committed (also baked into the Docker image via `COPY . .`) | Move firmware artifacts out of repo / gitignore |
| 10 | `data/active-devices.json` | Runtime device cache committed (churns on every deploy) | Gitignore; `data/*.json` already in `.renderignore` |

> Note: `src/certs/root-ca.crt` / `root-ca.key` exist on disk but are correctly gitignored (`*.crt`, `*.key`) and never tracked — leave as-is.

---

## 4. C. Generated / build artifacts tracked in git

| # | Path | Why it's there | Action |
|---|---|---|---|
| 1 | `graphify-out/` (8 files: `graph.json`, `graph.html`, `GRAPH_REPORT.md`, `.graphify_*`, `cache/`, `manifest.json`) | Generated knowledge-graph output; already listed in `.gitignore` but was tracked before the rule | `git rm -r --cached graphify-out` (keep on disk) |
| 2 | `dist/` | Build output; already gitignored, on disk only | No action |
| 3 | `influx_usage.csv` / `redis_usage.csv` / `data/influx_usage.csv` | Local usage traces; already gitignored | No action |

---

## 5. D. Stale tooling / config

| # | File | Problem | Action |
|---|---|---|---|
| 1 | `jest.config.js` | Jest is **not** installed (absent from `package.json` + `bun.lock`); all tests run via `bun test` | Delete |
| 2 | `tsconfig.test.json` | Jest-flavoured (`types: ["node","jest"]`), references `tests/**/*`, referenced by nothing (eslint uses `tsconfig.eslint.json`) | Delete |
| 3 | `scripts/run-unit-tests.sh` | Still cleans up/kills `jest` workers — stale tooling | Delete or rewrite for bun |
| 4 | `scripts/run-migration.sh` | Calls `npm run pki -- rotate` and `npm run pki:broker` — **those npm scripts don't exist** in `package.json` | Rewire to `bun scripts/pki/pki.ts …` or delete |
| 5 | `railway.json` + `railway.toml` | Two overlapping Railway configs | Consolidate to one (keep `railway.json` — schema-based), remove the other |
| 6 | `.renderignore` | Render-specific ignore; deploy target appears to be Railway now | Keep only if Render is still used, else delete |

---

## 6. E. Duplicate / orphan docs

### Exact duplicates
| File | Note |
|---|---|
| `Proof Display OTA .md` (root) | md5-identical to `docs/Proof Display OTA .md` (143 KB each) — keep the `docs/` copy, delete the root one |

### Root-level docs / notes to review (not referenced by README, likely stale)
- `ACTION_REQUIRED.md`, `AUDIT_SUMMARY.md` — one-off phase-1 audit outputs
- `OTA_E2E_TEST.md`, `TESTING_PLAN.md` — possibly superseded by `scripts/ota-e2e/` harness + CI
- `PRODUCTION-GRADE AUDIT GUIDE FOR CODEX AGENT.md` — agent-facing, one-off
- `redis_usage_proof.md`, `redis improvement.txt` — dev scratch notes
- `StatsMQTT-Lite-Provisioning.postman_collection.json` / `…environment.json` — dev tooling; consider moving to a `tools/` dir
- `complete_phase1.sh`, `phase1_fix.sh` — one-off migration scripts, unreferenced

### `docs/` docs not linked from `README.md` (review for staleness)
`docs/BUN_SECURITY.md`, `docs/CAPACITY.md`, `docs/COMPLIANCE.md`, `docs/CONFIG_MATRIX.md`,
`docs/FIRMWARE_CI_STAGING_ENV.md`, `docs/OTA_DEV_DOWNLOAD_TEST.md`, `docs/POST_PILOT_ROADMAP.md`,
`docs/PRODUCTION_HARDENING_PHASE0.md`, `docs/SECURITY_AUDIT_CHECKLIST.md`, `docs/SECURITY_PENTEST_REPORT.md`,
`docs/SERVER_OTA_REQUIREMENTS.md`, `docs/attention-iot-polling-roadmap.mdc`,
`docs/influx-flux-partner-migration.md`, `docs/influxdb refinement actions.md`,
`docs/proof-redis usage.md`, `docs/uncensored.md`
> Keep the `docs/runbooks/*` — those are operationally valuable.

---

## 7. F. Scripts not wired into `package.json` / CI — review each

These run standalone. Confirm each is still part of your workflow before keeping.

| Script | Appears to be | Verdict to confirm |
|---|---|---|
| `scripts/attention-roadmap-smoke.ts` | Smoke test for polling roadmap | Keep if still used |
| `scripts/instance.sh` | Instance/ops helper | Review |
| `scripts/integration-test.sh` | Referenced in README as ops script | Keep |
| `scripts/migrate-device-certificates-to-slots.ts` | One-time migration | Review — done? |
| `scripts/mongo-ping.ts` | Debug utility | Keep if used |
| `scripts/ota-e2e/*` | OTA end-to-end harness (contains committed keys — see §3) | Keep but remove keys from tracking |
| `scripts/ota/*` | OTA push/sign/upload tooling | Keep |
| `scripts/pki/*` | PKI tooling (broker cert gen/verify) | Keep |
| `scripts/run-connection-tests.sh` | Integration connection tests | Keep |
| `scripts/run-isolated-test-files.sh` | Wired to `npm test` | Keep |
| `scripts/smoke-redis-local.ts` | Local Redis smoke test | Keep if used |
| `scripts/sync-cursor-skill-commands.sh` | Cursor skill sync | Review |
| `scripts/sync-ota-webhook-to-railway.sh` | Railway env sync | Keep if used |
| `scripts/test-mqtt-mtls.ts` | mTLS debug client | Keep if used |
| `scripts/validate-env.ts` | Wired to CI (`bun scripts/validate-env.ts --production`) | Keep |
| `scripts/verify-gmb-audience.ts` | GMB pubsub audience check | Keep if used |

---

## 8. Verified-live files that naive "dead code" checks flag — DO NOT delete

These look unused to a naive importer scan but are load-bearing:

| File | How it's actually used |
|---|---|
| `src/config/swaggerSchemas.ts` | Loaded dynamically by `src/config/swagger.ts` via `swagger-jsdoc` API glob (`join(base, 'config', 'swaggerSchemas.js')`) — holds `@openapi` JSDoc |
| `src/lib/socials/gmb-pubsub.ts` | Re-exported from `src/webhooks/verify/pubsubGmb.ts` via `export { … } from` — easy for import scans to miss |
| `src/types/express.d.ts` | Ambient type augmentation for `req.correlationId`, `req.rawBody` — picked up automatically by `tsconfig` `include`, used by middleware |
| `src/storage/influx/repositories/*` | Imported through the `../types` barrel in `src/storage/influx/types.ts` — keep |

---

## 9. Suggested execution order

1. **Snapshot baseline:** run `bun run check` and `bun run test:e2e`; record pass/fail.
2. **Batch 1 — dead files (§2):** `git rm` files 1–14 (plus the 2 orphan tests). Re-run `bun run check`.
3. **Batch 2 — prune dead exports (§2.1):** edit `src/models/index.ts`; run `bun run check` + `test:unit`.
4. **Batch 3 — stale tooling (§5):** delete `jest.config.js`, `tsconfig.test.json`, stale scripts; consolidate Railway config. Re-run `bun run check`.
5. **Batch 4 — docs (§6):** delete root `Proof Display OTA .md` duplicate; review the root/docs candidates and remove confirmed-stale ones.
6. **Batch 5 — repo hygiene (§3, §4):**
   - `git rm -r --cached graphify-out` (already gitignored)
   - `git rm` private keys, CSRs, runtime CA state, firmware binary, `active-devices.json`, `service.crt.b64`
   - Extend `.gitignore`: `data/ca/*.log`, `data/ca/*.srl`, `data/*.bin`, `data/active-devices.json`, `scripts/ota-e2e/keys/`, `*.csr`
   - **History scrub:** keys were committed — use `git filter-repo` (or BFG) to purge `ota_private.pem` and any `.pem`/`.key` from history, then rotate the affected signing keys/CA.
7. **Final gate:** `bun run check` + `bun run test:e2e` + manual smoke (`bun run dev`).

## 10. Verification commands

```bash
bun run check        # lint + typecheck + build + unit tests
bun run test:e2e     # end-to-end suite (also runs in CI)
bun run validate-env # env validation (CI: --production)
```

## 11. Open questions for the team

- Is **Jest** being phased out for good (bun test only)? → removes `jest.config.js`, `tsconfig.test.json`, `run-unit-tests.sh`.
- Is the **Render** deployment still live? → decides `.renderignore` fate.
- Are the phase-1 one-off docs/scripts (`ACTION_REQUIRED.md`, `AUDIT_SUMMARY.md`, `complete_phase1.sh`, `phase1_fix.sh`, Postman collections) still needed?
- Should firmware artifacts (`.ino.bin`) live outside the repo (object storage) instead of being tracked?
- Which of the unreferenced `docs/*` are still accurate/needed?
