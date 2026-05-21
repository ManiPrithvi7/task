# Webhook → MQTT migration (ops)

## Phase 1b (implemented in statsmqtt)

- **Shopify async:** `processDailyMetrics` (Redis Lua) + `incrementCampaignUsage` after hot-path 200 via `shopifyAsyncMetrics.ts`. Set `ENABLE_DAILY_METRICS=false` to disable.
- **GMB enrichment:** `gmbEnrichmentWorker.ts` fetches review via GBP v4 API, upserts `GoogleBusinessReview`, optional enriched republish. Set `WEBHOOK_GMB_FAST_PATH_ONLY=true` to skip.

Requires `GOOGLE_BUSINESS_CLIENT_ID`, `GOOGLE_BUSINESS_CLIENT_SECRET`, and valid `Social` tokens in Mongo.

## Shadow mode

Set on statsmqtt before platform URL cutover:

```bash
WEBHOOK_MQTT_PUBLISH_ENABLED=false
```

Handlers still verify, dedupe, and log `webhook_latency`; no broker publish.

## Staged cutover order

1. **Shopify** — `POST /api/pos-promotions/webhooks/shopify` → mqtt host; validate `.../pos` on devices.
2. **Square** — verify + dedupe + 200 only (no POS in Phase 1a).
3. **GMB** — update Pub/Sub push URL and `GMB_PUBSUB_AUDIENCE` in GCP.

Keep Statsnapp routes returning 200 for 7 days (dual-ack) or use `WEBHOOK_INGRESS_DISABLED` on Statsnapp after cutover.

## ACL check

Devices must subscribe to `{MQTT_TOPIC_ROOT}/{clientId}/#` (e.g. `proof.mqtt/{clientId}/gmb`, `.../pos`). Confirm in `device_acls` / provisioning seed before cutover.

## Statsnapp registrar

Set `WEBHOOK_PUBLIC_BASE_URL` to the mqtt public HTTPS origin. Square HMAC uses that base + `/api/pos-promotions/webhooks/square` exactly.

## Outbox drain (Statsnapp)

One-time: process or mark `webhook_outbox_jobs` with `status IN (PENDING, PROCESSING)` as `FAILED` with `lastError: migrated_to_mqtt`, then remove Vercel cron `/api/webhooks/outbox`.
