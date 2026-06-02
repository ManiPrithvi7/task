import { Request, Response } from 'express';
import type { WebhookHandlerDeps } from './types';
import { verifyShopifyIngress } from './verify/shopifySquare';
import { buildShopifyDedupeKey, tryClaimWebhookDedupe } from './dedupe/redisDedupe';
import { resolveShopifyUserId } from './resolve/shopifyUser';
import { resolveDevicesForUser } from './resolve/resolveDevices';
import { scheduleShopifyAsyncMetrics } from './shopifyAsyncMetrics';
import { deliverPosScreenToUser, isShopifyPaidOrder } from './posWebhookDelivery';
import { parseShopifyOrderAudit } from './parseWebhookOrder';
import { webhookInfluxBatch, flushWebhookInflux } from './influxAudit';
import { WebhookLatencyTracker } from '../services/webhookMetrics';
import { logger } from '../utils/logger';

export async function handleShopifyWebhook(req: Request, res: Response, deps: WebhookHandlerDeps): Promise<void> {
  const tracker = new WebhookLatencyTracker();
  const isProduction = deps.appEnv === 'production';

  try {
    const shop = req.headers['x-shopify-shop-domain'] as string | undefined;
    const topic = req.headers['x-shopify-topic'] as string | undefined;
    const signature = req.headers['x-shopify-hmac-sha256'] as string | undefined;

    if (!shop || !topic) {
      logger.warn('[SHOPIFY_WEBHOOK] missing_headers', { shop: shop ?? null, topic: topic ?? null });
      res.status(400).json({ error: 'Missing required headers' });
      return;
    }

    const rawBody = req.rawBody?.toString('utf8') ?? '';
    logger.info('[SHOPIFY_WEBHOOK] received', {
      shop,
      topic,
      hasSignature: Boolean(signature),
      bodyBytes: rawBody.length
    });

    const verification = await verifyShopifyIngress(
      rawBody,
      signature ?? null,
      deps.webhookConfig,
      isProduction
    );

    await webhookInfluxBatch((influx) =>
      influx.writeWebhookReceived(
        {
          platform: 'shopify',
          eventType: topic,
          verified: verification.valid,
          shopDomain: shop,
          timestamp: new Date()
        },
        { flush: false }
      )
    );

    if (!verification.valid) {
      logger.warn('[SHOPIFY_WEBHOOK] verify_failed', { shop, topic, error: verification.error });
      await flushWebhookInflux();
      res.status(401).json({ error: verification.error || 'Invalid webhook signature' });
      return;
    }
    logger.info('[SHOPIFY_WEBHOOK] verify_ok', { shop, topic });
    tracker.markVerified();

    const dedupeKey = buildShopifyDedupeKey(shop, topic, rawBody);
    const isNew = await tryClaimWebhookDedupe(dedupeKey);
    if (!isNew) {
      logger.info('[SHOPIFY_WEBHOOK] duplicate', { shop, topic, dedupeKey });
      tracker.finish('shopify', { dedupeKey, dedupeHit: true, skippedPublish: true });
      await flushWebhookInflux();
      res.status(200).json({ acknowledged: true, duplicate: true });
      return;
    }

    const userId = await resolveShopifyUserId(shop);
    const devices = userId ? await resolveDevicesForUser(userId, deps.webhookConfig.deviceTarget) : [];
    tracker.markResolved();

    await webhookInfluxBatch((influx) =>
      influx.writeWebhookDeviceResolution(
        {
          platform: 'shopify',
          externalId: shop,
          userId: userId ?? undefined,
          resolvedDeviceCount: devices.length,
          timestamp: new Date()
        },
        { flush: false }
      )
    );

    if (!userId) {
      logger.info('[SHOPIFY_WEBHOOK] unknown_shop', { shop, topic });
      tracker.finish('shopify', { dedupeKey, skippedPublish: true });
      await flushWebhookInflux();
      res.status(200).json({ acknowledged: true });
      return;
    }

    scheduleShopifyAsyncMetrics(userId, topic, rawBody, deps.webhookConfig.enableDailyMetrics);

    let published = false;
    let lastTopic: string | undefined;
    let lastClientId: string | undefined;

    if (isShopifyPaidOrder(topic, rawBody)) {
      const orderAudit = parseShopifyOrderAudit(rawBody);
      const delivery = await deliverPosScreenToUser(deps, userId, 'shopify', devices, orderAudit);
      published = delivery.published;
      lastTopic = delivery.topic;
      lastClientId = delivery.clientId;
      tracker.markPublished();
      logger.info('[SHOPIFY_WEBHOOK] pos_published', {
        shop,
        webhookTopic: topic,
        userId,
        clientId: lastClientId,
        mqttTopic: lastTopic,
        published
      });
    }

    tracker.finish('shopify', {
      dedupeKey,
      clientId: lastClientId,
      topic: lastTopic,
      skippedPublish: !published && deps.webhookConfig.mqttPublishEnabled
    });
    await flushWebhookInflux();
    res.status(200).json({ acknowledged: true });
  } catch (error) {
    logger.error('[SHOPIFY_WEBHOOK] Error', {
      error: error instanceof Error ? error.message : String(error)
    });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}
