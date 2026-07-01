# Pilot v1 Exceptions

## OTA Download Endpoint

- Route: `GET /api/v1/ota/download/:version`
- Auth: none when `PILOT_MODE=true`
- Reason: firmware team needs minimal OTA HTTP streaming for real-world Pilot v1 testing
- Risk: version-scoped, rate-limited per IP, and logged at `warn`
- Cleanup: remove or protect with device mTLS before GA

For versions other than the legacy `test:1.1` smoke image, configure `PILOT_OTA_DOWNLOAD_BASE_URL`.
