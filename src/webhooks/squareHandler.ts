import { Request, Response } from 'express';
import type { WebhookHandlerDeps } from './types';
import { verifySquareIngress } from './verify/shopifySquare';
import { buildSquareDedupeKey, tryClaimWebhookDedupe } from './dedupe/redisDedupe';
import { resolveSquareUserId } from './resolve/squareMerchant';
import { resolveDevicesForUser } from './resolve/resolveDevices';
import { publishPosScreen } from './delivery/publishPosScreen';
import { getSquareWebhookUrl } from '../config/webhookConfig';
import { WebhookLatencyTracker } from '../services/webhookMetrics';
import { isSquarePaymentEvent } from '../lib/socials/integrations';
import { logger } from '../utils/logger';

export async function handleSquareWebhook(req: Request, res: Response, deps: WebhookHandlerDeps): Promise<void> {
  const tracker = new WebhookLatencyTracker();
  const isProduction = deps.appEnv === 'production';

  try {
    const signature =
      (req.headers['x-square-hmacsha256-signature'] as string | undefined) ??
      (req.headers['x-square-signature'] as string | undefined);
    const rawBody = req.rawBody?.toString('utf8') ?? '';

    let parsedBody: Record<string, unknown>;
    try {
      parsedBody = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      res.status(400).json({ success: false, error: 'Invalid JSON payload' });
      return;
    }

    const merchantId =
      typeof parsedBody.merchant_id === 'string' ? parsedBody.merchant_id : undefined;
    if (!merchantId) {
      res.status(400).json({ success: false, error: 'Missing merchant_id in payload' });
      return;
    }

    const eventType = typeof parsedBody.type === 'string' ? parsedBody.type : 'unknown';
    const webhookUrl = deps.webhookConfig.publicBaseUrl
      ? getSquareWebhookUrl(deps.webhookConfig.publicBaseUrl)
      : `${req.protocol}://${req.get('host')}/api/pos-promotions/webhooks/square`;

    const verification = await verifySquareIngress(
      rawBody,
      signature ?? null,
      merchantId,
      webhookUrl,
      deps.webhookConfig,
      isProduction
    );
    tracker.markVerified();

    if (!verification.valid) {
      res.status(401).json({ error: verification.error || 'Invalid webhook signature' });
      return;
    }

    const eventId = typeof parsedBody.event_id === 'string' ? parsedBody.event_id : null;
    const dedupeKey = buildSquareDedupeKey(merchantId, eventType, eventId, rawBody);
    const isNew = await tryClaimWebhookDedupe(dedupeKey);
    if (!isNew) {
      tracker.finish('square', { dedupeKey, dedupeHit: true, skippedPublish: true });
      res.status(200).json({ acknowledged: true, duplicate: true });
      return;
    }

    const userId = await resolveSquareUserId(merchantId);
    tracker.markResolved();

    let published = false;
    let lastTopic: string | undefined;
    let lastClientId: string | undefined;

    if (userId && isSquarePaymentEvent(eventType)) {
      const devices = await resolveDevicesForUser(userId, deps.webhookConfig.deviceTarget);
      for (const device of devices) {
        const result = await publishPosScreen(
          deps.mqttClient,
          deps.topicRoot,
          device.clientId,
          { platform: 'square', orderCount: 1 },
          deps.webhookConfig.mqttPublishEnabled
        );
        lastTopic = result.topic;
        lastClientId = device.clientId;
        published = published || result.published;
      }
    } else if (!userId) {
      logger.info('[SQUARE_WEBHOOK] Unknown merchant — ack', { merchantId });
    }

    tracker.markPublished();
    tracker.finish('square', {
      dedupeKey,
      clientId: lastClientId,
      topic: lastTopic,
      skippedPublish: !published && deps.webhookConfig.mqttPublishEnabled
    });

    res.status(200).json({ acknowledged: true });
  } catch (error) {
    logger.error('[SQUARE_WEBHOOK] Error', {
      error: error instanceof Error ? error.message : String(error)
    });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}
