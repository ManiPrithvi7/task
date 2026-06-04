import type { MqttClientManager } from '../servers/mqttClient';
import { publishPosScreen } from '../webhooks/delivery/publishPosScreen';
import { resolvePosContextForDevice } from '../lib/socials/resolvePosContextForDevice';
import { readPosDailyAggregate } from './pos/readPosDailyAggregate';
import { logger } from '../utils/logger';

export class PosConnectPull {
  constructor(
    private readonly mqttClient: MqttClientManager,
    private readonly mqttPublishEnabled: boolean
  ) {}

  async publishForDevice(deviceId: string, topicRoot: string): Promise<void> {
    const ctx = await resolvePosContextForDevice(deviceId);
    if (!ctx) return;

    const { orderCountToday, topSellerLine } = await readPosDailyAggregate(ctx.userId, new Date(), {
      platform: ctx.platform
    });

    const result = await publishPosScreen(
      this.mqttClient,
      topicRoot,
      deviceId,
      {
        platform: ctx.platform,
        orderCount: orderCountToday,
        topSeller: topSellerLine
      },
      this.mqttPublishEnabled,
      { userId: ctx.userId, deviceId }
    );

    if (!result.published && this.mqttPublishEnabled) {
      logger.warn('[POS_CONNECT] POS screen not delivered', {
        deviceId,
        userId: ctx.userId,
        platform: ctx.platform,
        orderCountToday,
        error: result.errorMessage
      });
    }
  }
}
