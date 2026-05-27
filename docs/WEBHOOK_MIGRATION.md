# Webhook → MQTT migration (ops)

## Production cutover (statsmqtt only)

1. **Deploy** with shadow first:
   ```bash
   WEBHOOK_ENABLED=true
   WEBHOOK_PUBLIC_BASE_URL=https://<mqtt-public-host>   # required; no trailing slash
   WEBHOOK_MQTT_PUBLISH_ENABLED=false
   REDIS_URL=... MONGODB_URI=...
   SHOPIFY_CLIENT_SECRET=...
   SQUARE_WEBHOOK_SIGNATURE_KEY=...   # or SQUARE_WEBHOOK_SIGNATURE_KEY_<merchantId>
   # GMB audience is derived automatically from WEBHOOK_PUBLIC_BASE_URL:
   #   https://<mqtt-public-host>/api/webhooks/google-business-reviews
   # Do NOT set GMB_PUBSUB_AUDIENCE unless WEBHOOK_PUBLIC_BASE_URL is absent.
   ```
2. **Validate:** `GET https://<host>/health/webhooks` → `ready: true`; send test webhooks; grep `webhook_latency` (expect `dedupeHit` on retries).
3. **Point platforms** (order): Shopify → Square → GMB Pub/Sub push URL (same paths on mqtt host).
4. **Go live:** `WEBHOOK_MQTT_PUBLISH_ENABLED=true`; confirm devices on `proof.mqtt/{clientId}/pos|gmb`.
5. **Statsnapp** (after stable): stub/remove webhook routes + outbox cron; archive pending outbox jobs — do not dual-deliver.

LB: route webhook paths only when `/health/webhooks` is 200.

## Implemented (dev complete)

- Square: `x-square-hmacsha256-signature`, HMAC `url+body`, POS MQTT on `payment.created|updated`
- Shopify/GMB: verify, dedupe, MQTT screen publish, async metrics/enrichment
- `redemptionCount` $inc on new Redemption
- `GET /health/webhooks` — redis + mongo + mqtt

## Shadow mode

`WEBHOOK_MQTT_PUBLISH_ENABLED=false` — verify, dedupe, `webhook_latency`; no broker publish.

## Env reference

See `.env.example` (Webhook ingress section).
