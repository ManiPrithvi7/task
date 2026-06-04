import express from 'express';
import request from 'supertest';
import { createPromotionRoutes } from './promotionRoutes';

jest.mock('../config/promotionConfig', () => ({
  resolvePromotionInvalidateApiKey: () => 'test-promo-key'
}));
jest.mock('../services/promotionService', () => ({
  invalidateAndFanout: jest.fn().mockResolvedValue({ invalidated: true, devicesNotified: 2 })
}));

import { invalidateAndFanout } from '../services/promotionService';

const mockFanout = invalidateAndFanout as jest.MockedFunction<typeof invalidateAndFanout>;

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
    expect(mockFanout).not.toHaveBeenCalled();
  });

  it('returns 400 when userId missing', async () => {
    const res = await request(buildApp())
      .post('/api/v1/promotions/invalidate-cache')
      .set('x-api-key', 'test-promo-key')
      .send({});
    expect(res.status).toBe(400);
    expect(mockFanout).not.toHaveBeenCalled();
  });

  it('returns 200 and fanout result with valid key', async () => {
    const res = await request(buildApp())
      .post('/api/v1/promotions/invalidate-cache')
      .set('x-api-key', 'test-promo-key')
      .send({ userId: '68d3753f9f99d6b73ae2d991' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ invalidated: true, devicesNotified: 2 });
    expect(mockFanout).toHaveBeenCalledWith(
      '68d3753f9f99d6b73ae2d991',
      expect.objectContaining({ topicRoot: 'proof.mqtt' })
    );
  });
});
