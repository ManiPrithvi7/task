# PKI scripts

Two stacks — one per cert type:

| Task | Command |
|------|---------|
| Root CA (dev/local) | `npm run pki -- init-ca` |
| Proof app MQTT client | `npm run pki -- app-client` |
| Rotate Root CA (disruptive) | `npm run pki -- rotate` |
| Print app `.env` base64 | `npm run pki -- print-app-env` |
| Broker server cert | `./scripts/pki/generate-broker-cert.sh` |
| Deploy broker to Railway | `./scripts/pki/print-railway-broker-env.sh` |
| Verify broker TLS | `./scripts/pki/verify-broker-tls.sh --compare-both` (8883 + proxy 12359) |

## Layout

- `data/ca/` — Root CA (`root-ca.crt`, `root-ca.key`) used by CAService + OpenSSL broker script
- `data/mqtt-client/` — Proof server MQTT client cert/key
- `broker/certs/` — Broker leaf cert/key (OpenSSL)

## Notes

- **App/device identity** uses `pki.ts` (CAService) — same KU/EKU profile as production `/sign-csr`.
- **Broker leaf** uses OpenSSL for explicit SAN control (`broker.withproof.io:8883`, Railway proxy/internal).
- **Production clients**: `MQTT_BROKER=broker.withproof.io`, `MQTT_PORT=8883`, `MQTT_TLS_SERVERNAME=broker.withproof.io`.
- Do **not** rotate Root CA for a hostname change — reissue broker cert only.
- Device certs in production come from the provisioning API, not these scripts.
