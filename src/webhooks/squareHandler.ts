import { Request, Response } from 'express';
import type { WebhookHandlerDeps } from './types';
import { verifySquareIngress } from './verify/shopifySquare';
import { buildSquareDedupeKey, tryClaimWebhookDedupe } from './dedupe/redisDedupe';
import { getSquareWebhookUrl } from '../config/webhookConfig';
import { resolveSquareUserId } from './resolve/squareMerchant';
import { resolveDevicesForUser } from './resolve/resolveDevices';
import { scheduleSquareAsyncMetrics } from './squareAsyncMetrics';
import { deliverPosScreenToUser } from './posWebhookDelivery';
import { parseSquareOrderAudit } from './parseWebhookOrder';
import { webhookInfluxBatch, flushWebhookInflux } from './influxAudit';
import { isSquareInvoiceEvent, isSquarePaymentEvent } from '../lib/socials/integrations';
import { WebhookLatencyTracker } from '../services/webhookMetrics';
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

    logger.info('[SQUARE_WEBHOOK] received', {
      merchantId,
      eventType,
      eventId,
      hasSignature: Boolean(signature),
      bodyBytes: rawBody.length
    });

    const verification = await verifySquareIngress(
      rawBody,
      signature ?? null,
      merchantId,
      expectedNotificationUrl,
      deps.webhookConfig,
      isProduction
    );

    const verified = verification.valid;

    await webhookInfluxBatch((influx) =>
      influx.writeWebhookReceived(
        {
          platform: 'square',
          eventType,
          verified,
          merchantId,
          timestamp: new Date()
        },
        { flush: false }
      )
    );

    if (!verified) {
      if (!isProduction) {
        logger.warn('[SQUARE_WEBHOOK] verify_failed_dev_continue', {
          merchantId,
          eventType,
          error: verification.error
        });
      } else {
        logger.warn('[SQUARE_WEBHOOK] verify_failed', {
          merchantId,
          eventType,
          error: verification.error
        });
        await flushWebhookInflux();
        res.status(401).json({ error: verification.error || 'Invalid webhook signature' });
        return;
      }
    } else {
      logger.info('[SQUARE_WEBHOOK] verify_ok', { merchantId, eventType });
      tracker.markVerified();
    }

    const dedupeKey = buildSquareDedupeKey(merchantId, eventType, eventId, rawBody);
    const isNew = await tryClaimWebhookDedupe(dedupeKey);
    if (!isNew) {
      logger.info('[SQUARE_WEBHOOK] duplicate', { merchantId, eventType, dedupeKey });
      tracker.finish('square', { dedupeKey, dedupeHit: true, skippedPublish: true });
      await flushWebhookInflux();
      res.status(200).json({ acknowledged: true, duplicate: true });
      return;
    }

    if (isSquareInvoiceEvent(eventType)) {
      logger.info('[SQUARE WEBHOOK][invoice]', { merchantId, eventType, eventId });
      tracker.finish('square', { dedupeKey, skippedPublish: true });
      await flushWebhookInflux();
      res.status(200).json({ acknowledged: true });
      return;
    }

    if (!isSquarePaymentEvent(eventType)) {
      logger.info('[SQUARE WEBHOOK][ignored]', { merchantId, eventType, eventId });
      tracker.finish('square', { dedupeKey, skippedPublish: true });
      await flushWebhookInflux();
      res.status(200).json({ acknowledged: true });
      return;
    }

    const userId = await resolveSquareUserId(merchantId);
    const devices = userId ? await resolveDevicesForUser(userId, deps.webhookConfig.deviceTarget) : [];
    tracker.markResolved();

    await webhookInfluxBatch((influx) =>
      influx.writeWebhookDeviceResolution(
        {
          platform: 'square',
          externalId: merchantId,
          userId: userId ?? undefined,
          resolvedDeviceCount: devices.length,
          timestamp: new Date()
        },
        { flush: false }
      )
    );

    if (!userId) {
      logger.info('[SQUARE_WEBHOOK] unknown_merchant', { merchantId, eventType });
      tracker.finish('square', { dedupeKey, skippedPublish: true });
      await flushWebhookInflux();
      res.status(200).json({ acknowledged: true });
      return;
    }

    scheduleSquareAsyncMetrics(userId, eventType, rawBody, deps.webhookConfig.enableDailyMetrics);

    const orderAudit = parseSquareOrderAudit(rawBody);
    const delivery = await deliverPosScreenToUser(deps, userId, 'square', devices, orderAudit);
    tracker.markPublished();

    logger.info('[SQUARE WEBHOOK][payment]', {
      merchantId,
      eventType,
      userId,
      clientId: delivery.clientId,
      topic: delivery.topic,
      published: delivery.published
    });

    tracker.finish('square', {
      dedupeKey,
      clientId: delivery.clientId,
      topic: delivery.topic,
      skippedPublish: !delivery.published && deps.webhookConfig.mqttPublishEnabled
    });
    await flushWebhookInflux();
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
