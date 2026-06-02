import type { WebhookHandlerDeps } from './types';
import type { ResolvedDeviceTarget } from './resolve/resolveDevices';
import { publishPosScreen } from './delivery/publishPosScreen';
import type { WebhookOrderAudit } from './parseWebhookOrder';
import { webhookInfluxBatch } from './influxAudit';

export async function deliverPosScreenToUser(
  deps: WebhookHandlerDeps,
  userId: string,
  platform: 'shopify' | 'square',
  devices: ResolvedDeviceTarget[],
  orderAudit?: WebhookOrderAudit | null
): Promise<{ published: boolean; clientId?: string; topic?: string }> {
  let published = false;
  let lastTopic: string | undefined;
  let lastClientId: string | undefined;

  for (const device of devices) {
    if (orderAudit) {
      await webhookInfluxBatch((influx) =>
        influx.writeWebhookOrder(
          {
            platform,
            deviceId: device.clientId,
            userId,
            orderId: orderAudit.orderId,
            totalAmount: orderAudit.totalAmount,
            currency: orderAudit.currency,
            itemCount: orderAudit.itemCount,
            timestamp: new Date()
          },
          { flush: false }
        )
      );
    }

    const result = await publishPosScreen(
      deps.mqttClient,
      deps.topicRoot,
      device.clientId,
      { platform, orderCount: 1 },
      deps.webhookConfig.mqttPublishEnabled,
      { userId, deviceId: device.clientId }
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
