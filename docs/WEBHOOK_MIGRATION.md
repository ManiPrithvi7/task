# Webhook → MQTT (GMB MVP)

## Scope

This service handles **Google Business Profile (GMB) review webhooks** only. Shopify/Square POS webhook ingress is out of scope for the `production_v2` MVP.

## Production setup

```bash
WEBHOOK_ENABLED=true
WEBHOOK_PUBLIC_BASE_URL=https://<mqtt-public-host>   # no trailing slash
WEBHOOK_MQTT_PUBLISH_ENABLED=true
REDIS_URL=... MONGODB_URI=...
INFLUXDB_URL=...
INFLUXDB_TOKEN=...
INFLUXDB_ORG=...
INFLUXDB_BUCKET=...
# GMB audience derived from WEBHOOK_PUBLIC_BASE_URL + /api/webhooks/google-business-reviews
```

1. Validate: `GET https://<host>/health/webhooks` → `ready: true` (internal probe).
2. Point GMB Pub/Sub push to `POST /api/webhooks/google-business-reviews`.
3. Confirm devices receive updates on `proof.mqtt/{clientId}/gmb`.
4. Audit trail: Influx measurements `webhook_received`, `webhook_device_resolution`, `webhook_mqtt_delivery`, `milestone_crossed`.

## Shadow mode

`WEBHOOK_MQTT_PUBLISH_ENABLED=false` — verify, dedupe, latency metrics; no broker publish.

## Health

`GET /health/webhooks` (internal) checks Redis, MongoDB, and MQTT readiness.
