import request from 'supertest';
import express from 'express';
import { createWebhookRoutes } from '@/routes/webhookRoutes';
import { TEST_WEBHOOK_SECRET } from './helpers/authFixtures';
import { tryClaimWebhookDedupe } from '@/webhooks/dedupe/redisDedupe';

jest.mock('@/webhooks/dedupe/redisDedupe', () => ({
  tryClaimWebhookDedupe: jest.fn().mockResolvedValue(true)
}));

const mockIngestRelease = jest.fn();
const mockAdvanceRollout = jest.fn();

function buildWebhookApp() {
  const app = express();
  app.use(express.json());
  app.use(
    createWebhookRoutes({
      mqttClient: { publish: jest.fn(), isConnected: () => true, getPendingAckCount: () => 0 } as never,
      topicRoot: 'proof.mqtt',
      webhookConfig: {
        enabled: false,
        mqttPublishEnabled: false,
        deviceTarget: 'primary',
        publicBaseUrl: 'https://example.com',
        gmbFastPathOnly: false,
        gmbPubsubSkipAuthVerify: false
      },
      appEnv: 'test',
      otaReleaseWebhook: {
        secret: TEST_WEBHOOK_SECRET,
        otaService: {
          ingestRelease: mockIngestRelease,
          advanceRollout: mockAdvanceRollout
        } as never
      }
    })
  );
  return app;
}

describe('E2E OTA webhook flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (tryClaimWebhookDedupe as jest.Mock).mockResolvedValue(true);
  });

  it('ingests release with valid bearer secret', async () => {
    mockIngestRelease.mockResolvedValue({
      ok: true,
      version: '4.3.1',
      created: true,
      currentPercentage: 1
    });

    const app = buildWebhookApp();
    const res = await request(app)
      .post('/api/webhooks/ota-release')
      .set('Authorization', `Bearer ${TEST_WEBHOOK_SECRET}`)
      .send({
        version: '4.3.1',
        object_key: 'firmware/4.3.1/firmware.bin',
        sha256: 'a'.repeat(64),
        signature: 'sig',
        size_bytes: 1000
      })
      .expect(200);

    expect(res.body.current_percentage).toBe(1);
    expect(mockIngestRelease).toHaveBeenCalled();
  });

  it('rejects missing or wrong bearer secret', async () => {
    const app = buildWebhookApp();
    const missing = await request(app).post('/api/webhooks/ota-release').send({ version: '1.0.0' });
    expect(missing.status).toBe(401);
    expect(missing.body.code).toBe('WEBHOOK_UNAUTHORIZED');

    const wrong = await request(app)
      .post('/api/webhooks/ota-release')
      .set('Authorization', 'Bearer wrong-secret')
      .send({ version: '1.0.0' });
    expect(wrong.status).toBe(401);
    expect(mockIngestRelease).not.toHaveBeenCalled();
  });

  it('returns 409 when rollout advance targets aborted release', async () => {
    mockAdvanceRollout.mockResolvedValue({
      ok: false,
      httpStatus: 409,
      code: 'ROLLOUT_ABORTED',
      error: 'Rollout for 2.3.0 is aborted'
    });

    const app = buildWebhookApp();
    const res = await request(app)
      .post('/api/webhooks/ota-rollout-advance')
      .set('Authorization', `Bearer ${TEST_WEBHOOK_SECRET}`)
      .send({ version: '2.3.0', rollout: { percentage: 10 } });

    expect(res.status).toBe(409);
  });
});
