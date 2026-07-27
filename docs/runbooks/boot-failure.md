# Boot failure

## Symptoms

Process exits during `validateConfig` / service init; logs show thrown Error from config or Influx health.

## Common causes

1. Missing prod vars: `MONGODB_URI`, Influx token/org/bucket/compliance, `REDIS_URL` (`rediss://`), JWT/AUTH when provisioning on
2. `TEST_OTA=true` in production
3. `OTA_ENABLED` without `OTA_RELEASE_WEBHOOK_SECRET` / OCI creds
4. `GMB_PUBSUB_SKIP_AUTH_VERIFY=true` in production
5. Influx unreachable when metrics hard-required at boot

## Actions

1. Run `bun scripts/validate-env.ts --production` with the deployment env (or load `tests/fixtures/prod-env.env` shape).
2. Compare against [docs/CONFIG_MATRIX.md](../CONFIG_MATRIX.md).
3. Fix env; redeploy. Do not bypass with skip-auth flags in prod.

## Related

- [docs/PRODUCTION_HARDENING_PHASE0.md](../PRODUCTION_HARDENING_PHASE0.md)
