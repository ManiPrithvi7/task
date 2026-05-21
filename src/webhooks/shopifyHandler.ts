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
      res.status(400).json({ error: 'Missing required headers' });
      return;
    }

    const rawBody = req.rawBody?.toString('utf8') ?? '';
    const verification = await verifyShopifyIngress(rawBody, signature ?? null, shop, isProduction);
    tracker.markVerified();

    if (!verification.valid) {
      res.status(401).json({ error: verification.error || 'Invalid webhook signature' });
      return;
    }

    const dedupeKey = buildShopifyDedupeKey(shop, topic, rawBody);
    const isNew = await tryClaimWebhookDedupe(dedupeKey);
    if (!isNew) {
      tracker.finish('shopify', { dedupeKey, skippedPublish: true });
      res.status(200).json({ acknowledged: true, duplicate: true });
      return;
    }

    const userId = await resolveShopifyUserId(shop);
    tracker.markResolved();

    if (!userId) {
      tracker.finish('shopify', { dedupeKey, skippedPublish: true });
      res.status(200).json({ acknowledged: true, unknownShop: true });
      return;
    }

    let published = false;
    let lastTopic: string | undefined;
    let lastClientId: string | undefined;

    if (topic === 'orders/paid') {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        /* ignore */
      }

      const financialStatus =
        typeof body.financial_status === 'string' ? body.financial_status : null;

      if (financialStatus === 'paid') {
        const devices = await resolveDevicesForUser(userId, deps.webhookConfig.deviceTarget);
        const orderCount = 1;

        for (const device of devices) {
          const result = await publishPosScreen(
            deps.mqttClient,
            deps.topicRoot,
            device.clientId,
            { platform: 'shopify', orderCount },
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
