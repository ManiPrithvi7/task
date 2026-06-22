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
import { ingestPosOrder } from '../services/pos/ingestPosOrder';
import { readPosDailyAggregate } from '../services/pos/readPosDailyAggregate';
import { webhookInfluxBatch, flushWebhookInflux } from './influxAudit';
import { isSquareInvoiceEvent, isSquarePaymentEvent } from '../lib/socials/integrations';
import { WebhookLatencyTracker } from '../services/webhookMetrics';
import { logger } from '../utils/logger';
import { respondWebhookHandlerError } from './webhookHandlerError';
import { finishWebhookAck } from './webhookHandlerResponse';

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

function parseSquareWebhookBody(
  rawBody: string,
  res: Response
): { merchantId: string; eventType: string; eventId: string | null } | null {
  let parsedBody: Record<string, unknown>;
  try {
    parsedBody = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    logger.warn('[SQUARE_WEBHOOK] invalid_json');
    res.status(400).json({ success: false, error: 'Invalid JSON payload' });
    return null;
  }

  const merchantId =
    typeof parsedBody.merchant_id === 'string' ? parsedBody.merchant_id : undefined;
  if (!merchantId) {
    logger.warn('[SQUARE_WEBHOOK] missing_merchant_id');
    res.status(400).json({ success: false, error: 'Missing merchant_id in payload' });
    return null;
  }

  const eventType = typeof parsedBody.type === 'string' ? parsedBody.type : 'unknown';
  const eventId = typeof parsedBody.event_id === 'string' ? parsedBody.event_id : null;
  return { merchantId, eventType, eventId };
}

async function deliverSquarePosOrderIfPaid(
  deps: WebhookHandlerDeps,
  userId: string,
  rawBody: string
): Promise<{ published: boolean; clientId?: string; topic?: string; orderCountToday?: number }> {
  const orderAudit = parseSquareOrderAudit(rawBody);
  if (!orderAudit?.paidAt) return { published: false };

  await ingestPosOrder({
    userId,
    platform: 'square',
    orderId: orderAudit.orderId,
    paidAt: orderAudit.paidAt,
    topSellerLine: orderAudit.topSellerLine,
    totalAmount: orderAudit.totalAmount,
    currency: orderAudit.currency,
    itemCount: orderAudit.itemCount
  });
  const aggregate = await readPosDailyAggregate(userId, new Date(), { platform: 'square' });
  const delivery = await deliverPosScreenToUser(
    deps,
    userId,
    'square',
    aggregate.orderCountToday,
    orderAudit.topSellerLine ?? aggregate.topSellerLine
  );
  return {
    published: delivery.published,
    clientId: delivery.clientId,
    topic: delivery.topic,
    orderCountToday: aggregate.orderCountToday
  };
}

async function handleSquareVerifiedEvent(
  res: Response,
  deps: WebhookHandlerDeps,
  tracker: WebhookLatencyTracker,
  merchantId: string,
  eventType: string,
  eventId: string | null,
  rawBody: string,
  dedupeKey: string
): Promise<void> {
  if (isSquareInvoiceEvent(eventType) || !isSquarePaymentEvent(eventType)) {
    const label = isSquareInvoiceEvent(eventType) ? 'invoice' : 'ignored';
    logger.info(`[SQUARE WEBHOOK][${label}]`, { merchantId, eventType, eventId });
    await finishWebhookAck(res, 'square', tracker, { dedupeKey, skippedPublish: true });
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
    await finishWebhookAck(res, 'square', tracker, { dedupeKey, skippedPublish: true });
    return;
  }

  scheduleSquareAsyncMetrics(userId, eventType, rawBody, deps.webhookConfig.enableDailyMetrics);

  const delivery = await deliverSquarePosOrderIfPaid(deps, userId, rawBody);
  tracker.markPublished();

  logger.info('[SQUARE WEBHOOK][payment]', {
    merchantId,
    eventType,
    userId,
    orderCountToday: delivery.orderCountToday,
    clientId: delivery.clientId,
    topic: delivery.topic,
    published: delivery.published
  });

  await finishWebhookAck(res, 'square', tracker, {
    dedupeKey,
    clientId: delivery.clientId,
    topic: delivery.topic,
    skippedPublish: !delivery.published && deps.webhookConfig.mqttPublishEnabled
  });
}

export async function handleSquareWebhook(req: Request, res: Response, deps: WebhookHandlerDeps): Promise<void> {
  const tracker = new WebhookLatencyTracker();
  const isProduction = deps.appEnv === 'production';

  try {
    const signature =
      (req.headers['x-square-hmacsha256-signature'] as string | undefined) ??
      (req.headers['x-square-signature'] as string | undefined);
    const rawBody = req.rawBody?.toString('utf8') ?? '';

    const parsed = parseSquareWebhookBody(rawBody, res);
    if (!parsed) return;

    const { merchantId, eventType, eventId } = parsed;
    const expectedNotificationUrl = resolveSquareNotificationUrl(req, deps.webhookConfig.publicBaseUrl, isProduction);

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

    await webhookInfluxBatch((influx) =>
      influx.writeWebhookReceived(
        {
          platform: 'square',
          eventType,
          verified: verification.valid,
          merchantId,
          timestamp: new Date()
        },
        { flush: false }
      )
    );

    if (!verification.valid) {
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
      await finishWebhookAck(
        res,
        'square',
        tracker,
        { dedupeKey, dedupeHit: true, skippedPublish: true },
        { acknowledged: true, duplicate: true }
      );
      return;
    }

    await handleSquareVerifiedEvent(res, deps, tracker, merchantId, eventType, eventId, rawBody, dedupeKey);
  } catch (error) {
    respondWebhookHandlerError(res, 'SQUARE_WEBHOOK', error);
  }
}
