import { Request, Response } from 'express';
import type { WebhookHandlerDeps } from './types';
import { verifyPubSubPushRequest } from './verify/pubsubGmb';
import {
  buildGmbDedupeKey,
  type GmbReviewNotification,
  SUPPORTED_GMB_EVENT_TYPES
} from './types/gmbReviewNotification';
import { tryClaimWebhookDedupe } from './dedupe/redisDedupe';
import { resolveGmbSocialContext } from './resolve/gmbSocial';
import { resolveDevicesForUser } from './resolve/resolveDevices';
import { publishGmbScreen } from './delivery/publishGmbScreen';
import { scheduleGmbEnrichment } from './gmbEnrichmentWorker';
import { WebhookLatencyTracker } from '../services/webhookMetrics';
import { logger } from '../utils/logger';
import { DeviceTransactionLog } from '../models/DeviceTransactionLog';
import mongoose from 'mongoose';

const ack = (res: Response, message: string, extra?: Record<string, unknown>) => {
  res.status(200).json({ message, acknowledged: true, ...extra });
};

const parseStarRating = (value: number | string | undefined): number => {
  if (typeof value === 'number' && value >= 1 && value <= 5) return value;
  if (typeof value === 'string') {
    const map: Record<string, number> = {
      ONE: 1,
      TWO: 2,
      THREE: 3,
      FOUR: 4,
      FIVE: 5
    };
    if (map[value]) return map[value];
    const n = parseInt(value, 10);
    if (n >= 1 && n <= 5) return n;
  }
  return 5;
};

export async function handleGmbWebhook(req: Request, res: Response, deps: WebhookHandlerDeps): Promise<void> {
  const tracker = new WebhookLatencyTracker();
  const isProduction = deps.appEnv === 'production';

  try {
    const authHeader = req.headers.authorization ?? null;
    const verification = await verifyPubSubPushRequest(
      authHeader,
      {
        audience: deps.webhookConfig.gmbPubsubAudience ?? null,
        serviceAccountEmail: deps.webhookConfig.gmbPubsubServiceAccountEmail,
        skipAuthVerify: deps.webhookConfig.gmbPubsubSkipAuthVerify
      },
      isProduction
    );

    if (!verification.valid) {
      if (isProduction) {
        res.status(401).json({ error: verification.error ?? 'Unauthorized' });
        return;
      }
      return ack(res, 'Auth skipped in non-production', { error: verification.error });
    }
    tracker.markVerified();

    const rawBody = req.rawBody?.toString('utf8') ?? '';
    let envelope: { message?: { data?: string } };
    try {
      envelope = JSON.parse(rawBody) as { message?: { data?: string } };
    } catch {
      return ack(res, 'Invalid JSON — acknowledged to prevent retry');
    }

    if (!envelope.message?.data) {
      return ack(res, 'No message data — acknowledged');
    }

    let notification: GmbReviewNotification;
    try {
      const decoded = Buffer.from(envelope.message.data, 'base64').toString('utf-8');
      notification = JSON.parse(decoded) as GmbReviewNotification;
    } catch {
      return ack(res, 'Invalid notification payload — acknowledged');
    }

    const { account, location, eventType } = notification;
    if (!eventType || !SUPPORTED_GMB_EVENT_TYPES.has(eventType)) {
      return ack(res, 'Ignored event type', { eventType });
    }

    if (!account || !location || !notification.review) {
      return ack(res, 'Incomplete notification — acknowledged');
    }

    const dedupeKey = buildGmbDedupeKey(account, location, notification.review);
    const isNew = await tryClaimWebhookDedupe(dedupeKey);
    if (!isNew) {
      tracker.finish('gmb', { dedupeKey, dedupeHit: true, skippedPublish: true });
      return ack(res, 'Duplicate — acknowledged', { dedupeKey });
    }

    const ctx = await resolveGmbSocialContext(account, location);
    tracker.markResolved();

    if (!ctx) {
      tracker.finish('gmb', { dedupeKey, skippedPublish: true });
      return ack(res, 'No linked social/location — acknowledged', { account, location });
    }

    const devices = await resolveDevicesForUser(ctx.userId, deps.webhookConfig.deviceTarget);
    const rating = parseStarRating(notification.starRating);
    const verifiedReview = ctx.verifiedReviewCount + (eventType === 'NEW_REVIEW' ? 1 : 0);

    let published = false;
    let lastTopic: string | undefined;
    let lastClientId: string | undefined;

    for (const device of devices) {
      const result = await publishGmbScreen(
        deps.mqttClient,
        deps.topicRoot,
        device.clientId,
        {
          verifiedReview,
          rating,
          reviewComment: notification.comment,
          reviewId: notification.review,
          qrText: 'https://g.page/r/review'
        },
        deps.webhookConfig.mqttPublishEnabled
      );
      lastTopic = result.topic;
      lastClientId = device.clientId;
      published = published || result.published;

      if (device.deviceObjectId) {
        try {
          await DeviceTransactionLog.create({
            deviceId: new mongoose.Types.ObjectId(device.deviceObjectId),
            userId: new mongoose.Types.ObjectId(ctx.userId),
            eventType: 'review_push',
            loggedAt: new Date(),
            metadata: { reviewId: notification.review, fastPath: true }
          });
        } catch (logErr) {
          logger.warn('[GMB_WEBHOOK] Transaction log failed', {
            error: logErr instanceof Error ? logErr.message : String(logErr)
          });
        }
      }
    }

    scheduleGmbEnrichment(notification, {
      userId: ctx.userId,
      locationObjectId: ctx.locationObjectId,
      account: account!,
      location: location!,
      deviceObjectId: devices[0]?.deviceObjectId,
      mqttClient: deps.mqttClient,
      topicRoot: deps.topicRoot,
      webhookConfig: deps.webhookConfig
    });

    tracker.markPublished();
    tracker.finish('gmb', {
      dedupeKey,
      clientId: lastClientId,
      topic: lastTopic,
      skippedPublish: !published && deps.webhookConfig.mqttPublishEnabled
    });

    return ack(res, 'Enqueued review notification', {
      account,
      location,
      review: notification.review,
      eventType
    });
  } catch (error) {
    logger.error('[GMB WEBHOOK] Unexpected error (returning 200)', {
      error: error instanceof Error ? error.message : String(error)
    });
    return ack(res, 'Acknowledged with processing error');
  }
}
