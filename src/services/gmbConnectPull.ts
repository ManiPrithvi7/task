import type { MqttClientManager } from '../servers/mqttClient';
import type { WebhookConfig } from '../config/webhookConfig';
import { publishGmbScreen } from '../webhooks/delivery/publishGmbScreen';
import { resolveGmbContextForDevice } from '../lib/socials/resolveDeviceGmb';
import { syncGmbLocationForDevice } from '../lib/socials/syncDeviceGmb';
import { getActiveDeviceCache } from './deviceService';
import { getUserIntegrations } from './userIntegrationCache';
import { logger } from '../utils/logger';
// TEMP STIMULATE — remove after testing
import { shouldSkipForStimulate } from '../utils/stimulateAllowlist';

export class GmbConnectPull {
  constructor(
    private readonly mqttClient: MqttClientManager,
    private readonly mqttPublishEnabled: boolean,
    private readonly webhookConfig: WebhookConfig
  ) {}

  async publishForDevice(deviceId: string, topicRoot: string): Promise<void> {
    // TEMP STIMULATE — remove after testing
    if (await shouldSkipForStimulate(deviceId, 'gmb')) {
      logger.info('[STIM_SKIP] GmbConnectPull skipping stim device', { deviceId });
      return;
    }
    let ctx = await resolveGmbContextForDevice(deviceId);
    if (!ctx) {
      const active = await getActiveDeviceCache().getActive(deviceId);
      const integrations = active?.businessId ? await getUserIntegrations(active.businessId) : null;
      ctx = await syncGmbLocationForDevice(deviceId, this.webhookConfig, {
        knownLocationId: integrations?.gmb?.locationId
      });
    }
    if (!ctx) {
      logger.info('[GMB_CONNECT] No GMB snapshot to publish', {
        deviceId,
        reason: 'no_mongo_location_and_gbp_api_returned_none'
      });
      return;
    }

    const rating =
      typeof ctx.averageRating === 'number' && Number.isFinite(ctx.averageRating)
        ? ctx.averageRating
        : undefined;

    await publishGmbScreen(
      this.mqttClient,
      topicRoot,
      deviceId,
      {
        verifiedReview: ctx.verifiedReviewCount,
        rating,
      },
      this.mqttPublishEnabled,
      { deviceId }
    );
    logger.debug('[GMB_CONNECT] Published GMB snapshot from Mongo', {
      deviceId,
      verifiedReview: ctx.verifiedReviewCount,
      rating
    });
  }
}
