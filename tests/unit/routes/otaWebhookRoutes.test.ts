import express from 'express';
import request from 'supertest';
import { createWebhookRoutes } from '@/routes/webhookRoutes';
import type { MqttClientManager } from '@/servers/mqttClient';
import { loadWebhookConfig } from '@/config/webhookConfig';

jest.mock('@/webhooks/dedupe/redisDedupe', () => ({
  tryClaimWebhookDedupe: jest.fn().mockResolvedValue(true)
}));

const mockIngestRelease = jest.fn();
const mockAdvanceRollout = jest.fn();

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
        otaService: {
          ingestRelease: mockIngestRelease,
          advanceRollout: mockAdvanceRollout
        } as never
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

  it('forwards rollout and ignores broadcast', async () => {
    mockIngestRelease.mockResolvedValue({
      ok: true,
      version: '4.3.1-mvp',
      created: true,
      currentPercentage: 1
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
        broadcast: true,
        rollout: { strategy: 'percentage', percentage: 1, deviceIds: ['DEVICE-13'] }
      });

    expect(res.status).toBe(200);
    expect(res.body.current_percentage).toBe(1);
    expect(mockIngestRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        version: '4.3.1-mvp',
        objectKey: 'firmware/4.3.1-mvp/firmware.bin',
        broadcast: true,
        rollout: expect.objectContaining({ percentage: 1, deviceIds: ['DEVICE-13'] })
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
        signature: 'sig'
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SIGNATURE');
  });

  it('advance returns 409 ROLLOUT_ABORTED', async () => {
    mockAdvanceRollout.mockResolvedValue({
      ok: false,
      httpStatus: 409,
      code: 'ROLLOUT_ABORTED',
      error: 'Rollout for 2.3.0 is aborted'
    });

    const res = await request(buildApp())
      .post('/api/webhooks/ota-rollout-advance')
      .set('Authorization', 'Bearer test-webhook-secret')
      .send({ version: '2.3.0', rollout: { percentage: 10 } });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ROLLOUT_ABORTED');
  });

  it('advance succeeds', async () => {
    mockAdvanceRollout.mockResolvedValue({
      ok: true,
      version: '2.3.0',
      currentPercentage: 10,
      previousPercentage: 1
    });

    const res = await request(buildApp())
      .post('/api/webhooks/ota-rollout-advance')
      .set('Authorization', 'Bearer test-webhook-secret')
      .send({ version: '2.3.0', rollout: { percentage: 10 } });

    expect(res.status).toBe(200);
    expect(res.body.current_percentage).toBe(10);
  });
});
