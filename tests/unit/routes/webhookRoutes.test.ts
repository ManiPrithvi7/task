import express from 'express';
import request from 'supertest';
import { createWebhookRoutes } from '@/routes/webhookRoutes';
import type { MqttClientManager } from '@/servers/mqttClient';
import { loadWebhookConfig } from '@/config/webhookConfig';

const mockPublish = jest.fn().mockResolvedValue(undefined);

const mockMqttClient = {
  publish: mockPublish,
  isConnected: () => true,
  getPendingAckCount: () => 0
} as unknown as MqttClientManager;

function buildApp() {
  const app = express();
  const webhookConfig = loadWebhookConfig();
  webhookConfig.enabled = true;
  webhookConfig.mqttPublishEnabled = false;
  app.use(
    createWebhookRoutes({
      mqttClient: mockMqttClient,
      topicRoot: 'proof.mqtt',
      webhookConfig,
      appEnv: 'test'
    })
  );
  return app;
}

describe('webhookRoutes', () => {
  beforeEach(() => {
    mockPublish.mockClear();
  });

  it('returns 200 ack for GMB invalid JSON (Pub/Sub pattern)', async () => {
    const res = await request(buildApp())
      .post('/api/webhooks/google-business-reviews')
      .set('Authorization', 'Bearer fake')
      .send('not-json');
    expect(res.status).toBe(200);
    expect(res.body.acknowledged).toBe(true);
  });
});
