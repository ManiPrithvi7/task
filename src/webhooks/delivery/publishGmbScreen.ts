import type { MqttClientManager } from '../../servers/mqttClient';
import { buildGmbScreenPayload, buildScreenEnvelope } from '../../services/screenEnvelope';
import { sha256Payload } from '../../utils/payloadHash';
import { logger } from '../../utils/logger';
import { webhookInfluxBatch } from '../influxAudit';

export type GmbFastScreenInput = {
  verifiedReview: number;
  rating?: number;
  qrText?: string;
  reviewComment?: string;
  reviewId?: string;
};

export type GmbScreenAuditContext = {
  userId?: string;
  deviceId: string;
};

export type GmbScreenPublishResult = {
  topic: string;
  published: boolean;
  payload: string;
  success: boolean;
  errorMessage?: string;
};

export async function publishGmbScreen(
  mqttClient: MqttClientManager,
  topicRoot: string,
  clientId: string,
  input: GmbFastScreenInput,
  mqttPublishEnabled: boolean,
  audit?: GmbScreenAuditContext
): Promise<GmbScreenPublishResult> {
  const rating = input.rating ?? 4;
  const reviews =
    input.reviewComment && input.reviewId
      ? [
          {
            id: 1,
            googleReview: input.reviewComment,
            rating: String(rating)
          }
        ]
      : [];

  const { payload: screenPayload, envelopeOpts } = buildGmbScreenPayload({
    verifiedReview: input.verifiedReview,
    rating,
    qrText: input.qrText,
    reviews
  });

  const envelope = buildScreenEnvelope('gmb', screenPayload, envelopeOpts);

  const payload = JSON.stringify(envelope);
  const topic = `${topicRoot}/${clientId}/gmb`;
  let published = false;
  let success = true;
  let errorMessage: string | undefined;

  if (!mqttPublishEnabled) {
    logger.info('[WEBHOOK_GMB] Publish skipped (WEBHOOK_MQTT_PUBLISH_ENABLED=false)', {
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
      logger.warn('[WEBHOOK_GMB] Publish failed', { clientId, topic, error: errorMessage });
    }
  }
  if (audit) {
    await webhookInfluxBatch((influx) =>
      influx.writeWebhookMqttDelivery(
        {
          platform: 'gmb',
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
