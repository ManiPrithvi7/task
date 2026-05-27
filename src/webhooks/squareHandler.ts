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

function resolveSquareNotificationUrl(
  req: Request,
  publicBaseUrl: string,
  isProduction: boolean
): string {
  if (publicBaseUrl) return getSquareWebhookUrl(publicBaseUrl);
  if (isProduction) return '';
  const host = req.get('host');
  return host ? `${req.protocol}://${host}/api/pos-promotions/webhooks/square` : '';
}

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
      logger.warn('[SQUARE_WEBHOOK] invalid_json');
      res.status(400).json({ success: false, error: 'Invalid JSON payload' });
      return;
    }

    const merchantId =
      typeof parsedBody.merchant_id === 'string' ? parsedBody.merchant_id : undefined;
    if (!merchantId) {
      logger.warn('[SQUARE_WEBHOOK] missing_merchant_id');
      res.status(400).json({ success: false, error: 'Missing merchant_id in payload' });
      return;
    }

    const eventType = typeof parsedBody.type === 'string' ? parsedBody.type : 'unknown';
    const eventId = typeof parsedBody.event_id === 'string' ? parsedBody.event_id : null;
    const publicBaseUrl = deps.webhookConfig.publicBaseUrl;
    const expectedNotificationUrl = resolveSquareNotificationUrl(req, publicBaseUrl, isProduction);
    const urlSource = publicBaseUrl
      ? 'configured'
      : isProduction
        ? 'missing_public_base_url'
        : 'dev_fallback';

    logger.info('[SQUARE_WEBHOOK] received', {
      merchantId,
      eventType,
      eventId,
      hasSignature: Boolean(signature),
      bodyBytes: rawBody.length,
      urlSource
    });

    const verification = await verifySquareIngress(
      rawBody,
      signature ?? null,
      merchantId,
      expectedNotificationUrl,
      deps.webhookConfig,
      isProduction
    );

    if (!verification.valid) {
      logger.warn('[SQUARE_WEBHOOK] verify_failed', {
        merchantId,
        eventType,
        error: verification.error,
        expectedNotificationUrl: expectedNotificationUrl || null,
        publicBaseUrl: publicBaseUrl || null,
        urlSource
      });
      res.status(401).json({ error: verification.error || 'Invalid webhook signature' });
      return;
    }
    logger.info('[SQUARE_WEBHOOK] verify_ok', { merchantId, eventType });
    tracker.markVerified();

    logger.info('[SQUARE_WEBHOOK] notification', { merchantId, eventType, eventId });

    const dedupeKey = buildSquareDedupeKey(merchantId, eventType, eventId, rawBody);
    const isNew = await tryClaimWebhookDedupe(dedupeKey);
    if (!isNew) {
      logger.info('[SQUARE_WEBHOOK] duplicate', { merchantId, eventType, dedupeKey });
      tracker.finish('square', { dedupeKey, dedupeHit: true, skippedPublish: true });
      res.status(200).json({ acknowledged: true, duplicate: true });
      return;
    }

    const userId = await resolveSquareUserId(merchantId);
    tracker.markResolved();

    let published = false;
    let lastTopic: string | undefined;
    let lastClientId: string | undefined;

    if (!userId) {
      logger.info('[SQUARE_WEBHOOK] unknown_merchant', { merchantId, eventType });
    } else if (!isSquarePaymentEvent(eventType)) {
      logger.info('[SQUARE_WEBHOOK] ignored_event_type', { merchantId, eventType });
    } else {
      const devices = await resolveDevicesForUser(userId, deps.webhookConfig.deviceTarget);
      logger.info('[SQUARE_WEBHOOK] processing', {
        merchantId,
        eventType,
        userId,
        deviceCount: devices.length,
        mqttPublish: deps.webhookConfig.mqttPublishEnabled
      });

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
    }

    tracker.markPublished();
    tracker.finish('square', {
      dedupeKey,
      clientId: lastClientId,
      topic: lastTopic,
      skippedPublish: !published && deps.webhookConfig.mqttPublishEnabled
    });

    logger.info('[SQUARE_WEBHOOK] enqueued', {
      merchantId,
      eventType,
      published,
      clientId: lastClientId,
      mqttTopic: lastTopic,
      dedupeKey
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
