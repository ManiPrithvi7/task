import type { MqttClientManager } from '../servers/mqttClient';
import { publishGmbScreen } from '../webhooks/delivery/publishGmbScreen';
import { resolveGmbContextForDevice } from '../lib/socials/resolveDeviceGmb';
import { logger } from '../utils/logger';

export class GmbConnectPull {
  constructor(
    private readonly mqttClient: MqttClientManager,
    private readonly mqttPublishEnabled: boolean
  ) {}

  async publishForDevice(deviceId: string, topicRoot: string): Promise<void> {
    const ctx = await resolveGmbContextForDevice(deviceId);
    if (!ctx) return;

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
        celebration: 'false'
      },
      this.mqttPublishEnabled,
      { userId: ctx.userId, deviceId }
    );

    logger.debug('[GMB_CONNECT] Published GMB snapshot from Mongo', {
      deviceId,
      verifiedReview: ctx.verifiedReviewCount,
      rating
    });
  }
}
