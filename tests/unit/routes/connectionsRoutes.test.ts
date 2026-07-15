import express from 'express';
import request from 'supertest';
import { createConnectionsRoutes } from '@/routes/connectionsRoutes';

jest.mock('@/config/connectionsConfig', () => ({
  resolveConnectionsValidateApiKey: () => 'test-key'
}));

function app() {
  const a = express();
  a.use(express.json());
  a.use(
    '/api/v1',
    createConnectionsRoutes({
      statsPublisher: {
        publishPromotionForDevice: jest.fn()
      } as never,
      topicRoot: 'proof.mqtt'
    })
  );
  return a;
}

describe('connectionsRoutes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects missing API key', async () => {
    const res = await request(app())
      .post('/api/v1/connections/validate')
      .send({ userId: 'u1', event: 'campaign.updated' });
    expect(res.status).toBe(401);
  });

  it('accepts canvas.updated event', async () => {
    const res = await request(app())
      .post('/api/v1/connections/validate')
      .set('x-api-key', 'test-key')
      .send({ userId: '674a1b2c3d4e5f678901234', event: 'canvas.updated' });

    expect(res.status).toBe(200);
  });

  it('accepts social.disconnected with instagram provider', async () => {
    const res = await request(app())
      .post('/api/v1/connections/validate')
      .set('x-api-key', 'test-key')
      .send({ userId: '674a1b2c3d4e5f678901234', event: 'social.disconnected', provider: 'instagram' });

    expect(res.status).toBe(200);
  });

  it('rejects invalid event', async () => {
    const res = await request(app())
      .post('/api/v1/connections/validate')
      .set('x-api-key', 'test-key')
      .send({ userId: 'u1', event: 'bad.event' });
    expect(res.status).toBe(400);
  });
});
