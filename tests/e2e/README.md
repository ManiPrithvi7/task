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

## Flows covered

| File | Flow |
|------|------|
| `pki-provisioning.e2e.test.ts` | Onboarding → sign-csr → download URL |
| `mtls-http.e2e.test.ts` | mTLS fingerprint match (mismatch covered in `tests/unit/middleware/mtlsAuth.test.ts`) |
| `recovery-reissue.e2e.test.ts` | Recovery token reissue |
| `ota-webhook.e2e.test.ts` | OTA release ingest + rollout advance |
| `ota-offer.e2e.test.ts` | Device OTA offer with rollout |
| `gmb-webhook.e2e.test.ts` | GMB Pub/Sub verify stub |
| `connections-smoke.e2e.test.ts` | Connections validate API |

## Manual MQTT / device E2E

Full broker + device simulations remain in `scripts/ota-e2e/` and `scripts/integration-test.sh`.

## Environment

E2E tests mock dependencies and do not require `.env`. Avoid `TEST_OTA=true` in the shell when running the main server in production mode.
