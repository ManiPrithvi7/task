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
import { GoogleBusinessLocation } from '../models/GoogleBusinessLocation';
import { resolveDevicesForUser } from './resolve/resolveDevices';
import { publishGmbScreen } from './delivery/publishGmbScreen';
import mongoose from 'mongoose';
import { logger } from '../utils/logger';
// TEMP STIMULATE — remove after testing
import { shouldSkipForStimulate } from '../utils/stimulateAllowlist';

export type GmbEnrichmentContext = {
  businessId: string;
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

  const oauth2Client = await getValidOAuth2Client(ctx.businessId, ctx.webhookConfig);
  if (!oauth2Client) {
    logger.warn('[GMB_ENRICHMENT] OAuth unavailable — skip enrichment', {
      businessId: ctx.businessId
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

  const locationDoc = await GoogleBusinessLocation.findById(locationOid).lean();
  const verifiedReview = locationDoc?.totalReviewCount ?? 0;

  const devices = await resolveDevicesForUser(
    ctx.businessId,
    ctx.webhookConfig.deviceTarget
  );

  for (const device of devices) {
    // TEMP STIMULATE — remove after testing
    if (await shouldSkipForStimulate(device.clientId, 'gmb')) {
      logger.info('[STIM_SKIP] GMB enrichment skipping stim device', { deviceId: device.clientId });
      continue;
    }
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
      ctx.webhookConfig.mqttPublishEnabled,
      { deviceId: device.clientId }
    );
  }

  logger.info('[GMB_ENRICHMENT] Enriched review republished', {
    businessId: ctx.businessId,
    reviewId: stored.reviewId,
    account: resolveGmbAccountResourceName(notification.account!)
  });
}
