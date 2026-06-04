import type { WebhookHandlerDeps } from './types';
import { publishPosScreen } from './delivery/publishPosScreen';
import { getActiveDeviceCache } from '../services/deviceService';
import { logger } from '../utils/logger';

export async function deliverPosScreenToUser(
  deps: WebhookHandlerDeps,
  userId: string,
  platform: 'shopify' | 'square',
  orderCountToday: number,
  topSeller?: string
): Promise<{ published: boolean; clientId?: string; topic?: string }> {
  const activeDevices = (await getActiveDeviceCache().getAllActive()).filter(
    (d) => d.userId === userId
  );

  if (activeDevices.length === 0) {
    logger.debug('[WEBHOOK_POS] No active-cache devices for user — skip MQTT', {
      userId,
      platform,
      orderCountToday
    });
    return { published: false };
  }

  let published = false;
  let lastTopic: string | undefined;
  let lastClientId: string | undefined;

  for (const device of activeDevices) {
    const result = await publishPosScreen(
      deps.mqttClient,
      deps.topicRoot,
      device.deviceId,
      {
        platform,
        orderCount: orderCountToday,
        topSeller
      },
      deps.webhookConfig.mqttPublishEnabled,
      { userId, deviceId: device.deviceId }
    );
    lastTopic = result.topic;
    lastClientId = device.deviceId;
    published = published || result.published;
  }

  return { published, clientId: lastClientId, topic: lastTopic };
}

export function isShopifyPaidOrder(topic: string, rawBody: string): boolean {
  if (topic !== 'orders/paid') return false;
  try {
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    return body.financial_status === 'paid';
  } catch {
    return false;
  }
}
