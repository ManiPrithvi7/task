# Configuration matrix

Environment variables read by `loadConfig()` / enforced by `validateConfig()`. Run `bun scripts/validate-env.ts --production` in CI to fail on prod misconfiguration.

| Variable | Required in prod | Default (dev) | Pilot / notes |
|----------|------------------|---------------|---------------|
| `MONGODB_URI` | Yes | — | Shared with web app |
| `INFLUXDB_TOKEN` | Yes | — | Metrics + PKI CT log |
| `INFLUXDB_ORG` | Yes | `statsmqtt` | |
| `INFLUXDB_BUCKET` | Yes | `metrics` | |
| `INFLUXDB_COMPLIANCE_BUCKET` | Yes | `pki_compliance` | |
| `REDIS_URL` | Yes | optional | Must be `rediss://`; Upstash expected |
| `AUTH_SECRET` | When provisioning on | empty | Admin JWT for onboarding |
| `JWT_SECRET` / `PROVISIONING_JWT_SECRET` | When provisioning on (prod) | dev fallback | No default in production |
| `MQTT_BROKER` | No | `broker.withproof.io` | |
| `MQTT_TLS_*` | When mTLS-only | — | CA + client cert/key via BASE64 or PEM env |
| `PROVISIONING_ENABLED` | No | `true` | Set `false` to disable PKI routes |
| `MQTT_TLS_CA_BASE64` + `MQTT_TLS_CA_KEY_BASE64` | When signing from env | — | Pair required if key env set |
| `OTA_ENABLED` | No | off | Requires OCI creds + webhook secret in prod |
| `OTA_RELEASE_WEBHOOK_SECRET` | When OTA on (prod) | warned in dev | CI release ingest |
| `OCI_*` / `OCI_API_PRIVATE_KEY_BASE64` | When OTA on | — | OCI PAR firmware storage |
| `TEST_OTA` | **Blocked in prod** | off | Dev/CI only (`assertTestOtaAllowed`) |
| `OTA_REGISTRATION_DEFER_CONCURRENCY` | No | `10` | Registration storm throttle |
| `DEFERRED_WORK_REARM` | No | on (`false` disables) | Rollback for deferred drain re-arm |
| `DEFERRED_WORK_HANDLER_TIMEOUT_MS` | No | `30000` | Bound on deferred work handler; timeout counts failed |
| `INSTAGRAM_SERVERLESS_URL` | No | off | Poller uses direct Graph if unset |
| `IG_POLL_*` | No | see `instagramPollingConfig.ts` | Dual Redis schedulers |
| `STIMULATE_DEVICE` | No | off | In-process IG/GMB ramp (pilot) |
| `GMB_*` / webhook vars | When GMB webhooks on | see `webhookConfig.ts` | Pub/Sub push verification |
| `GMB_PUBSUB_SKIP_AUTH_VERIFY` | **Blocked in prod** | off | Fail-fast at `validateWebhookConfig` |
| `ENABLE_METRICS_COLLECTION` | Must not be `false` | `true` | Disabling throws at validate |

## CI validate-env

Do not run `bun scripts/validate-env.ts --production` on an empty env. Load the checked-in fixture:

```bash
set -a && source tests/fixtures/prod-env.env && set +a
bun scripts/validate-env.ts --production
```

## Feature env gates (in-process)

| Subsystem | Gate | Startup behavior |
|-----------|------|------------------|
| Provisioning / PKI | `PROVISIONING_ENABLED` | Routes + CAService init |
| Instagram poller | Redis connected + scripts | Skipped if Redis down |
| OTA | `OTA_ENABLED=true` | OCI + routes + rollout scheduler |
| GMB webhooks | `webhookConfig` validation | Mounted on HTTP server |
| Stimulate | `STIMULATE_DEVICE` | TEMP ramp service on `/active` |
| TEST OTA fan-out | `TEST_OTA=true` (non-prod) | Ungated proof:1.0.1 offers |
| Deferred drain re-arm | `DEFERRED_WORK_REARM` | Second drain after enqueue-during-flight |

**Pilot limits:** deferred work queue is in-memory (lost on restart / not multi-instance). MQTT ingress buffers max 100 messages during warmup (drop-oldest). See [docs/runbooks/](runbooks/README.md) and [docs/PRODUCTION_HARDENING_PHASE0.md](PRODUCTION_HARDENING_PHASE0.md).

See also [docs/PILOT_V1_EXCEPTIONS.md](PILOT_V1_EXCEPTIONS.md) and [docs/uncensored.md](uncensored.md).
