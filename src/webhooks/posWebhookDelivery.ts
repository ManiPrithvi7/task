import type { WebhookHandlerDeps } from './types';
import { resolveDevicesForUser } from './resolve/resolveDevices';
import { publishPosScreen } from './delivery/publishPosScreen';

export async function deliverPosScreenToUser(
  deps: WebhookHandlerDeps,
  userId: string,
  platform: 'shopify' | 'square'
): Promise<{ published: boolean; clientId?: string; topic?: string }> {
  const devices = await resolveDevicesForUser(userId, deps.webhookConfig.deviceTarget);
  let published = false;
  let lastTopic: string | undefined;
  let lastClientId: string | undefined;

  for (const device of devices) {
    const result = await publishPosScreen(
      deps.mqttClient,
      deps.topicRoot,
      device.clientId,
      { platform, orderCount: 1 },
      deps.webhookConfig.mqttPublishEnabled
    );
    lastTopic = result.topic;
    lastClientId = device.clientId;
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
