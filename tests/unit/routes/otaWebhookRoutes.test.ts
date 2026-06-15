import express from 'express';
import request from 'supertest';
import { createWebhookRoutes } from '@/routes/webhookRoutes';
import type { MqttClientManager } from '@/servers/mqttClient';
import { loadWebhookConfig } from '@/config/webhookConfig';

const mockIngestRelease = jest.fn();

const mockMqttClient = {
  publish: jest.fn(),
  isConnected: () => true,
  getPendingAckCount: () => 0
} as unknown as MqttClientManager;

function buildApp(secret = 'test-webhook-secret') {
  const app = express();
  const webhookConfig = loadWebhookConfig();
  webhookConfig.enabled = false;
  app.use(
    createWebhookRoutes({
      mqttClient: mockMqttClient,
      topicRoot: 'proof.mqtt',
      webhookConfig,
      appEnv: 'test',
      otaReleaseWebhook: {
        secret,
        otaService: { ingestRelease: mockIngestRelease } as never
      }
    })
  );
  return app;
}

describe('webhookRoutes OTA release', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects missing bearer token', async () => {
    const res = await request(buildApp())
      .post('/api/webhooks/ota-release')
      .send({ version: '4.3.1' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('WEBHOOK_UNAUTHORIZED');
  });

  it('rejects wrong bearer token', async () => {
    const res = await request(buildApp())
      .post('/api/webhooks/ota-release')
      .set('Authorization', 'Bearer wrong')
      .send({ version: '4.3.1' });
    expect(res.status).toBe(401);
  });

  it('forwards valid payload to ingest service', async () => {
    mockIngestRelease.mockResolvedValue({
      ok: true,
      version: '4.3.1-mvp',
      broadcast: true,
      created: true
    });

    const res = await request(buildApp())
      .post('/api/webhooks/ota-release')
      .set('Authorization', 'Bearer test-webhook-secret')
      .send({
        version: '4.3.1-mvp',
        object_key: 'firmware/4.3.1-mvp/firmware.bin',
        sha256: 'a'.repeat(64),
        signature: 'sig',
        size_bytes: 1000,
        broadcast: true
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.version).toBe('4.3.1-mvp');
    expect(mockIngestRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        version: '4.3.1-mvp',
        objectKey: 'firmware/4.3.1-mvp/firmware.bin',
        broadcast: true
      })
    );
  });

  it('returns service error status', async () => {
    mockIngestRelease.mockResolvedValue({
      ok: false,
      httpStatus: 400,
      code: 'INVALID_SIGNATURE',
      error: 'Ed25519 signature verification failed'
    });

    const res = await request(buildApp())
      .post('/api/webhooks/ota-release')
      .set('Authorization', 'Bearer test-webhook-secret')
      .send({
        version: '4.3.1',
        object_key: 'firmware/4.3.1/firmware.bin',
        sha256: 'a'.repeat(64),
        signature: 'bad'
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SIGNATURE');
  });

  it('works when WEBHOOK_ENABLED is false', async () => {
    mockIngestRelease.mockResolvedValue({
      ok: true,
      version: '4.3.1',
      broadcast: false,
      created: false
    });

    const res = await request(buildApp())
      .post('/api/webhooks/ota-release')
      .set('Authorization', 'Bearer test-webhook-secret')
      .send({
        version: '4.3.1',
        object_key: 'firmware/4.3.1/firmware.bin',
        sha256: 'a'.repeat(64),
        signature: 'sig'
      });

    expect(res.status).toBe(200);
  });
});
