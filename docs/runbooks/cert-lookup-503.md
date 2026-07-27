# Cert lookup 503

## Symptoms

HTTP mTLS routes return 503 `CERT_LOOKUP_UNAVAILABLE`. MQTT registration may throw / retry on `CertLookupUnavailableError` instead of treating the device as unprovisioned.

## Causes

MongoDB blip or query failure during active certificate lookup.

## Actions

1. Check Mongo Atlas connectivity / IP allowlist / connection pool.
2. Confirm this is **not** `CERT_NOT_ACTIVE` (403) — that means truly no active cert.
3. After Mongo recovers, devices should register on next `/active` / retry.

## Related

- [docs/SECURITY_AUDIT_CHECKLIST.md](../SECURITY_AUDIT_CHECKLIST.md)
