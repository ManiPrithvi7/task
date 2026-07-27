# E2E HTTP flow tests

Behavior-contract tests under `tests/e2e/` exercise route wiring with mocked externals (Mongo, Redis, OCI, MQTT). They do **not** start the full `StatsMqttLite` process or a live MQTT broker.

## Run

```bash
bun run test:e2e
```

Optional full gate:

```bash
bun run check:full
```

CI runs `bun run check`, `validate-env` against [`tests/fixtures/prod-env.env`](../fixtures/prod-env.env), then `bun run test:e2e`. Bun version: align with `package.json` `engines.bun` (CI pins 1.3.x).

## Flows covered

| File | Flow |
|------|------|
| `pki-provisioning.e2e.test.ts` | Onboarding → sign-csr → download URL |
| `mtls-http.e2e.test.ts` | mTLS match; mismatch → 403; DB blip → 503 |
| `recovery-reissue.e2e.test.ts` | Recovery reissue; invalid token reject |
| `ota-webhook.e2e.test.ts` | OTA release ingest; wrong secret; rollout advance |
| `ota-offer.e2e.test.ts` | Device OTA offer with rollout |
| `gmb-webhook.e2e.test.ts` | GMB Pub/Sub verify pass/fail stub |
| `connections-smoke.e2e.test.ts` | Connections validate API |
| `registration-storm.e2e.test.ts` | Deferred queue storm dedupe + enqueue-during-drain re-arm |
| `misconfig-boot.e2e.test.ts` | Prod misconfig fail-fast (`TEST_OTA`, Redis) |

## Manual MQTT / device E2E

Full broker + device simulations remain in `scripts/ota-e2e/` and `scripts/integration-test.sh` (not CI).

## Environment

E2E tests mock dependencies and do not require `.env`. Avoid `TEST_OTA=true` in the shell when running the main server in production mode.

Prod env validation fixture: `tests/fixtures/prod-env.env` (fake secrets only).
