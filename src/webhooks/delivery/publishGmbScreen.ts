import type { MqttClientManager } from '../../servers/mqttClient';
import { buildScreenEnvelope, gmbReviewMetrics } from '../../services/screenEnvelope';
import { logger } from '../../utils/logger';

export type GmbFastScreenInput = {
  verifiedReview: number;
  rating?: number;
  qrText?: string;
  reviewComment?: string;
  reviewId?: string;
  celebration?: 'true' | 'false';
};

export async function publishGmbScreen(
  mqttClient: MqttClientManager,
  topicRoot: string,
  clientId: string,
  input: GmbFastScreenInput,
  mqttPublishEnabled: boolean
): Promise<{ topic: string; published: boolean }> {
  const { nextGoal, remainingGoal, progress } = gmbReviewMetrics(input.verifiedReview);
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

  const envelope = buildScreenEnvelope(
    'gmb',
    {
      qrText: input.qrText ?? 'https://g.page/r/review',
      verifiedReview: input.verifiedReview,
      rating,
      nextGoal,
      remainingGoal,
      progress,
      reviews
    },
    {
      muted: 'false',
      celebration: input.celebration ?? 'false'
    }
  );

  const topic = `${topicRoot}/${clientId}/gmb`;

  if (!mqttPublishEnabled) {
    logger.info('[WEBHOOK_GMB] Publish skipped (WEBHOOK_MQTT_PUBLISH_ENABLED=false)', {
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
