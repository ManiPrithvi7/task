import type { MqttClientManager } from '../../servers/mqttClient';
import { buildScreenEnvelope } from '../../services/screenEnvelope';
import { sha256Payload } from '../../utils/payloadHash';
import { logger } from '../../utils/logger';
import { webhookInfluxBatch } from '../influxAudit';

export type PosScreenInput = {
  platform: 'shopify' | 'square';
  orderCount: number;
  topSeller?: string;
};

export type PosScreenAuditContext = {
  userId?: string;
  deviceId: string;
};

export type PosScreenPublishResult = {
  topic: string;
  published: boolean;
  payload: string;
  success: boolean;
  errorMessage?: string;
};

export async function publishPosScreen(
  mqttClient: MqttClientManager,
  topicRoot: string,
  clientId: string,
  input: PosScreenInput,
  mqttPublishEnabled: boolean,
  audit?: PosScreenAuditContext
): Promise<PosScreenPublishResult> {
  const envelope = buildScreenEnvelope('pos', {
    platform: input.platform,
    orderCount: input.orderCount,
    top_seller: input.topSeller ?? 'Order'
  });

  const payload = JSON.stringify(envelope);
  const topic = `${topicRoot}/${clientId}/pos`;
  let published = false;
  let success = true;
  let errorMessage: string | undefined;

  if (!mqttPublishEnabled) {
    logger.info('[WEBHOOK_POS] Publish skipped (WEBHOOK_MQTT_PUBLISH_ENABLED=false)', {
      clientId,
      topic
    });
  } else {
    try {
      await mqttClient.publish({
        topic,
        payload,
        qos: 1,
        retain: false
      });
      published = true;
    } catch (err: unknown) {
      success = false;
      errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn('[WEBHOOK_POS] Publish failed', { clientId, topic, error: errorMessage });
    }
  }

  if (audit) {
    await webhookInfluxBatch((influx) =>
      influx.writeWebhookMqttDelivery(
        {
          platform: input.platform,
          deviceId: audit.deviceId,
          userId: audit.userId,
          success,
          published,
          payloadSizeBytes: Buffer.byteLength(payload, 'utf8'),
          payloadSha256: sha256Payload(payload),
          errorMessage,
          timestamp: new Date()
        },
        { flush: false }
      )
    );
  }

  return { topic, published, payload, success, errorMessage };
}
