import express from 'express';
import request from 'supertest';
import { createPromotionRoutes } from '@/routes/promotionRoutes';

jest.mock('@/config/connectionsConfig', () => ({
  resolveConnectionsValidateApiKey: () => 'test-promo-key'
}));
jest.mock('@/services/promotionService', () => ({
  handleConnectionValidateEvent: jest.fn().mockResolvedValue({
    ok: true,
    event: 'campaign.updated',
    userId: '68d3753f9f99d6b73ae2d991',
    integrationsCached: false,
    devicesNotified: 2
  })
}));

import { handleConnectionValidateEvent } from '@/services/promotionService';

const mockHandler = handleConnectionValidateEvent as jest.MockedFunction<
  typeof handleConnectionValidateEvent
>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1',
    createPromotionRoutes({
      statsPublisher: {
        publishPromotionForDevice: jest.fn().mockResolvedValue(undefined)
      } as never,
      topicRoot: 'proof.mqtt'
    })
  );
  return app;
}

describe('promotionRoutes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 without valid API key', async () => {
    const res = await request(buildApp())
      .post('/api/v1/promotions/invalidate-cache')
      .send({ userId: 'user-1' });
    expect(res.status).toBe(401);
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('returns 400 when userId missing', async () => {
    const res = await request(buildApp())
      .post('/api/v1/promotions/invalidate-cache')
      .set('x-api-key', 'test-promo-key')
      .send({});
    expect(res.status).toBe(400);
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('returns 200 via deprecated alias (campaign.updated)', async () => {
    const res = await request(buildApp())
      .post('/api/v1/promotions/invalidate-cache')
      .set('x-api-key', 'test-promo-key')
      .send({ userId: '68d3753f9f99d6b73ae2d991' });
    expect(res.status).toBe(200);
    expect(res.body.devicesNotified).toBe(2);
    expect(res.body.deprecated).toBe(true);
    expect(mockHandler).toHaveBeenCalledWith(
      'campaign.updated',
      '68d3753f9f99d6b73ae2d991',
      expect.objectContaining({ topicRoot: 'proof.mqtt' })
    );
  });
});
