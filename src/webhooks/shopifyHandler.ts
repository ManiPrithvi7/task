import { Request, Response } from 'express';
import type { WebhookHandlerDeps } from './types';
import { verifyShopifyIngress } from './verify/shopifySquare';
import { buildShopifyDedupeKey, tryClaimWebhookDedupe } from './dedupe/redisDedupe';
import { resolveShopifyUserId } from './resolve/shopifyUser';
import { resolveDevicesForUser } from './resolve/resolveDevices';
import { publishPosScreen } from './delivery/publishPosScreen';
import { WebhookLatencyTracker } from '../services/webhookMetrics';
import { scheduleShopifyAsyncMetrics } from './shopifyAsyncMetrics';
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

    if (!verification.valid) {
      logger.warn('[SHOPIFY_WEBHOOK] verify_failed', { shop, topic, error: verification.error });
      res.status(401).json({ error: verification.error || 'Invalid webhook signature' });
      return;
    }
    logger.info('[SHOPIFY_WEBHOOK] verify_ok', { shop, topic });
    tracker.markVerified();

    logger.info('[SHOPIFY_WEBHOOK] notification', { shop, topic });

    const dedupeKey = buildShopifyDedupeKey(shop, topic, rawBody);
    const isNew = await tryClaimWebhookDedupe(dedupeKey);
    if (!isNew) {
      logger.info('[SHOPIFY_WEBHOOK] duplicate', { shop, topic, dedupeKey });
      tracker.finish('shopify', { dedupeKey, dedupeHit: true, skippedPublish: true });
      res.status(200).json({ acknowledged: true, duplicate: true });
      return;
    }

    const userId = await resolveShopifyUserId(shop);
    tracker.markResolved();

    if (!userId) {
      logger.info('[SHOPIFY_WEBHOOK] unknown_shop', { shop, topic });
      tracker.finish('shopify', { dedupeKey, skippedPublish: true });
      res.status(200).json({ acknowledged: true, unknownShop: true });
      return;
    }

    let published = false;
    let lastTopic: string | undefined;
    let lastClientId: string | undefined;

    if (topic !== 'orders/paid') {
      logger.info('[SHOPIFY_WEBHOOK] ignored_topic', { shop, topic });
    } else {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        logger.warn('[SHOPIFY_WEBHOOK] invalid_json', { shop, topic });
      }

      const financialStatus =
        typeof body.financial_status === 'string' ? body.financial_status : null;

      if (financialStatus !== 'paid') {
        logger.info('[SHOPIFY_WEBHOOK] ignored_financial_status', {
          shop,
          topic,
          financialStatus
        });
      } else {
        const devices = await resolveDevicesForUser(userId, deps.webhookConfig.deviceTarget);
        logger.info('[SHOPIFY_WEBHOOK] processing', {
          shop,
          topic,
          userId,
          deviceCount: devices.length,
          mqttPublish: deps.webhookConfig.mqttPublishEnabled
        });

        for (const device of devices) {
          const result = await publishPosScreen(
            deps.mqttClient,
            deps.topicRoot,
            device.clientId,
            { platform: 'shopify', orderCount: 1 },
            deps.webhookConfig.mqttPublishEnabled
          );
          lastTopic = result.topic;
          lastClientId = device.clientId;
          published = published || result.published;
        }

        scheduleShopifyAsyncMetrics(
          userId,
          topic,
          rawBody,
          deps.webhookConfig.enableDailyMetrics
        );
      }
    }

    tracker.markPublished();
    tracker.finish('shopify', {
      dedupeKey,
      deviceId: lastClientId,
      clientId: lastClientId,
      topic: lastTopic,
      skippedPublish: !published && deps.webhookConfig.mqttPublishEnabled
    });

    logger.info('[SHOPIFY_WEBHOOK] enqueued', {
      shop,
      topic,
      published,
      clientId: lastClientId,
      mqttTopic: lastTopic,
      dedupeKey
    });

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
