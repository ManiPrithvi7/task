import { Request, Response } from 'express';
import type { WebhookHandlerDeps } from './types';
import { verifyShopifyIngress } from './verify/shopifySquare';
import { buildShopifyDedupeKey, tryClaimWebhookDedupe } from './dedupe/redisDedupe';
import { resolveShopifyUserId } from './resolve/shopifyUser';
import { resolveDevicesForUser } from './resolve/resolveDevices';
import { scheduleShopifyAsyncMetrics } from './shopifyAsyncMetrics';
import { deliverPosScreenToUser, isShopifyPaidOrder } from './posWebhookDelivery';
import { parseShopifyOrderAudit } from './parseWebhookOrder';
import { ingestPosOrder } from '../services/pos/ingestPosOrder';
import { readPosDailyAggregate } from '../services/pos/readPosDailyAggregate';
import { webhookInfluxBatch, flushWebhookInflux } from './influxAudit';
import { WebhookLatencyTracker } from '../services/webhookMetrics';
import { logger } from '../utils/logger';
import { isShopifyComplianceTopic } from './shopifyComplianceTopics';
import { respondWebhookHandlerError } from './webhookHandlerError';
import { finishWebhookAck } from './webhookHandlerResponse';

async function deliverShopifyPosOrderIfPaid(
  deps: WebhookHandlerDeps,
  userId: string,
  shop: string,
  topic: string,
  rawBody: string,
  tracker: WebhookLatencyTracker
): Promise<{ published: boolean; topic?: string; clientId?: string }> {
  if (!isShopifyPaidOrder(topic, rawBody)) return { published: false };

  const orderAudit = parseShopifyOrderAudit(rawBody);
  if (!orderAudit?.paidAt) return { published: false };

  await ingestPosOrder({
    userId,
    platform: 'shopify',
    orderId: orderAudit.orderId,
    paidAt: orderAudit.paidAt,
    topSellerLine: orderAudit.topSellerLine,
    totalAmount: orderAudit.totalAmount,
    currency: orderAudit.currency,
    itemCount: orderAudit.itemCount
  });
  const { orderCountToday, topSellerLine } = await readPosDailyAggregate(userId, new Date(), {
    platform: 'shopify'
  });
  const delivery = await deliverPosScreenToUser(
    deps,
    userId,
    'shopify',
    orderCountToday,
    orderAudit.topSellerLine ?? topSellerLine
  );
  tracker.markPublished();
  logger.info('[SHOPIFY_WEBHOOK] pos_published', {
    shop,
    webhookTopic: topic,
    userId,
    orderCountToday,
    clientId: delivery.clientId,
    mqttTopic: delivery.topic,
    published: delivery.published
  });
  return {
    published: delivery.published,
    topic: delivery.topic,
    clientId: delivery.clientId
  };
}

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

    if (isShopifyComplianceTopic(topic)) {
      logger.info('[SHOPIFY_WEBHOOK] compliance_ack', { shop, topic, bodyBytes: rawBody.length });
      await finishWebhookAck(res, 'shopify', tracker, { skippedPublish: true }, { acknowledged: true, compliance: true });
      return;
    }

    const dedupeKey = buildShopifyDedupeKey(shop, topic, rawBody);
    const isNew = await tryClaimWebhookDedupe(dedupeKey);
    if (!isNew) {
      logger.info('[SHOPIFY_WEBHOOK] duplicate', { shop, topic, dedupeKey });
      await finishWebhookAck(
        res,
        'shopify',
        tracker,
        { dedupeKey, dedupeHit: true, skippedPublish: true },
        { acknowledged: true, duplicate: true }
      );
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
      await finishWebhookAck(res, 'shopify', tracker, { dedupeKey, skippedPublish: true });
      return;
    }

    scheduleShopifyAsyncMetrics(userId, topic, rawBody, deps.webhookConfig.enableDailyMetrics);

    const delivery = await deliverShopifyPosOrderIfPaid(deps, userId, shop, topic, rawBody, tracker);

    await finishWebhookAck(res, 'shopify', tracker, {
      dedupeKey,
      clientId: delivery.clientId,
      topic: delivery.topic,
      skippedPublish: !delivery.published && deps.webhookConfig.mqttPublishEnabled
    });
  } catch (error) {
    respondWebhookHandlerError(res, 'SHOPIFY_WEBHOOK', error);
  }
}
