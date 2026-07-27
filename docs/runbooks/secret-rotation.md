# Secret rotation — JWT and OTA webhook

## JWT / AUTH_SECRET / PROVISIONING_JWT_SECRET

1. Generate new secrets offline; store in platform secret store.
2. Deploy with new values (brief dual-accept window is **not** implemented — expect onboarding tokens to invalidate).
3. Re-issue admin JWTs; notify operators.

## OTA_RELEASE_WEBHOOK_SECRET

1. Update secret in deployment.
2. Update CI / release pipeline Bearer token in the same change window.
3. Confirm `/api/webhooks/ota-release` accepts a canary request.

Never commit real secrets; CI uses `tests/fixtures/prod-env.env` fake values only.
