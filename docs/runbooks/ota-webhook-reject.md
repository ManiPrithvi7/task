# OTA webhook reject

## Symptoms

`POST /api/webhooks/ota-release` or `ota-rollout-advance` returns 401 `WEBHOOK_UNAUTHORIZED`.

## Causes

- Missing/wrong `Authorization: Bearer` vs `OTA_RELEASE_WEBHOOK_SECRET`
- Secret rotated on server but not in CI / caller

## Actions

1. Verify caller sends Bearer matching current secret (constant-time compare; length must match).
2. If rotating: update secret in secrets manager + CI, deploy, then update callers (see [secret-rotation.md](secret-rotation.md)).
3. Confirm OTA enabled and webhook mounted (`OTA_RELEASE_WEBHOOK_SECRET` set).

Rollback of stricter checks: none required for auth reject (always fail-closed on bad secret).
