import type { MqttClientManager } from '../../servers/mqttClient';
import { buildScreenEnvelope } from '../../services/screenEnvelope';
import { logger } from '../../utils/logger';

export type PosScreenInput = {
  platform: 'shopify' | 'square';
  orderCount: number;
  topSeller?: string;
};

export async function publishPosScreen(
  mqttClient: MqttClientManager,
  topicRoot: string,
  clientId: string,
  input: PosScreenInput,
  mqttPublishEnabled: boolean
): Promise<{ topic: string; published: boolean }> {
  const envelope = buildScreenEnvelope('pos', {
    platform: input.platform,
    orderCount: input.orderCount,
    top_seller: input.topSeller ?? 'Order'
  });

  const topic = `${topicRoot}/${clientId}/pos`;

  if (!mqttPublishEnabled) {
    logger.info('[WEBHOOK_POS] Publish skipped (WEBHOOK_MQTT_PUBLISH_ENABLED=false)', {
      clientId,
      topic
    });
    return { topic, published: false };
  }

  await mqttClient.publish({
    topic,
    payload: JSON.stringify(envelope),
    qos: 1,
    retain: false
  });

  return { topic, published: true };
}
