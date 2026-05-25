import type { GmbReviewNotification } from './types/gmbReviewNotification';
import {
  resolveGmbLocationResourceName,
  resolveGmbAccountResourceName
} from './types/gmbReviewNotification';
import type { WebhookConfig } from '../config/webhookConfig';
import type { MqttClientManager } from '../servers/mqttClient';
import { getValidOAuth2Client } from '../services/googleBusiness/googleBusinessOAuth';
import {
  mapReviewPayloadToStorage,
  resolveGmbReviewPayload
} from './gmb/gmbReviewResolve';
import { GoogleBusinessReview } from '../models/GoogleBusinessReview';
import { GoogleBusinessLocation } from '../models/GoogleBusinessLocation';
import { resolveDevicesForUser } from './resolve/resolveDevices';
import { publishGmbScreen } from './delivery/publishGmbScreen';
import { DeviceTransactionLog } from '../models/DeviceTransactionLog';
import mongoose from 'mongoose';
import { logger } from '../utils/logger';

export type GmbEnrichmentContext = {
  userId: string;
  locationObjectId: string;
  account: string;
  location: string;
  deviceObjectId?: string;
  mqttClient: MqttClientManager;
  topicRoot: string;
  webhookConfig: WebhookConfig;
};

export function scheduleGmbEnrichment(
  notification: GmbReviewNotification,
  ctx: GmbEnrichmentContext
): void {
  setImmediate(() => {
    void runGmbEnrichment(notification, ctx).catch((err) => {
      logger.error('[GMB_ENRICHMENT] Async worker failed', {
        error: err instanceof Error ? err.message : String(err),
        review: notification.review
      });
    });
  });
}

async function runGmbEnrichment(
  notification: GmbReviewNotification,
  ctx: GmbEnrichmentContext
): Promise<void> {
  if (ctx.webhookConfig.gmbFastPathOnly) {
    logger.debug('[GMB_ENRICHMENT] Skipped (WEBHOOK_GMB_FAST_PATH_ONLY=true)', {
      review: notification.review
    });
    return;
  }

  const oauth2Client = await getValidOAuth2Client(ctx.userId, ctx.webhookConfig);
  if (!oauth2Client) {
    logger.warn('[GMB_ENRICHMENT] OAuth unavailable — skip enrichment', {
      userId: ctx.userId
    });
    return;
  }

  const locationResourceName = resolveGmbLocationResourceName(
    notification.account!,
    notification.location!
  );

  const reviewPayload = await resolveGmbReviewPayload(
    oauth2Client as Parameters<typeof resolveGmbReviewPayload>[0],
    notification,
    { locationResourceName }
  );

  if (!reviewPayload) {
    logger.warn('[GMB_ENRICHMENT] Could not resolve review payload', {
      review: notification.review
    });
    return;
  }

  const stored = mapReviewPayloadToStorage(reviewPayload);
  const locationOid = new mongoose.Types.ObjectId(ctx.locationObjectId);

  await GoogleBusinessReview.findOneAndUpdate(
    { reviewId: stored.reviewId },
    {
      $set: {
        locationId: locationOid,
        starRating: stored.starRating,
        comment: stored.comment,
        reviewerName: stored.reviewerName,
        updateTime: stored.updateTime,
        notificationReceived: true
      },
      $setOnInsert: {
        reviewId: stored.reviewId,
        createTime: stored.createTime
      }
    },
    { upsert: true }
  );

  const locationDoc = await GoogleBusinessLocation.findById(locationOid).lean();
  const verifiedReview = locationDoc?.totalReviewCount ?? 0;

  const devices = await resolveDevicesForUser(
    ctx.userId,
    ctx.webhookConfig.deviceTarget
  );

  for (const device of devices) {
    await publishGmbScreen(
      ctx.mqttClient,
      ctx.topicRoot,
      device.clientId,
      {
        verifiedReview: Math.max(verifiedReview, 1),
        rating: stored.starRating || 5,
        reviewComment: stored.comment ?? undefined,
        reviewId: stored.reviewId,
        qrText: 'https://g.page/r/review'
      },
      ctx.webhookConfig.mqttPublishEnabled
    );

    if (device.deviceObjectId) {
      try {
        await DeviceTransactionLog.create({
          deviceId: new mongoose.Types.ObjectId(device.deviceObjectId),
          userId: new mongoose.Types.ObjectId(ctx.userId),
          eventType: 'review_push',
          loggedAt: new Date(),
          metadata: { reviewId: stored.reviewId, enriched: true }
        });
      } catch (logErr) {
        logger.warn('[GMB_ENRICHMENT] Transaction log failed', {
          error: logErr instanceof Error ? logErr.message : String(logErr)
        });
      }
    }
  }

  logger.info('[GMB_ENRICHMENT] Enriched review upserted and republished', {
    userId: ctx.userId,
    reviewId: stored.reviewId,
    account: resolveGmbAccountResourceName(notification.account!)
  });
}
