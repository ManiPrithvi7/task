import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createInstagramMetricsRoutes } from '../../../src/routes/instagramMetricsRoutes';
import { AuthService } from '../../../src/services/authService';

jest.mock('../../../src/services/instagramMetricsReadService', () => ({
  getInstagramMetricsCurrent: jest.fn().mockResolvedValue({
    followerCount: 500,
    lastSyncedAt: '2026-08-01T00:00:00.000Z',
    source: 'mongo'
  }),
  getInstagramMetricsHistory: jest.fn().mockResolvedValue({
    series: [{ t: '2026-08-01T00:00:00.000Z', count: 480 }],
    totalGrowth: 20,
    lastSyncAt: '2026-08-01T00:00:00.000Z'
  })
}));

const SECRET = 'test-auth-secret';
const USER_ID = '507f1f77bcf86cd799439011';

function bearer(): string {
  return jwt.sign({ sub: USER_ID }, SECRET, { algorithm: 'HS256' });
}

describe('instagramMetricsRoutes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createInstagramMetricsRoutes({ authService: new AuthService(SECRET) }));

  it('GET /instagram/metrics/current requires auth', async () => {
    const res = await request(app).get('/api/v1/instagram/metrics/current');
    expect(res.status).toBe(401);
  });

  it('GET /instagram/metrics/current returns metrics', async () => {
    const res = await request(app)
      .get('/api/v1/instagram/metrics/current')
      .set('Authorization', `Bearer ${bearer()}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ followerCount: 500, source: 'mongo' });
  });

  it('GET /instagram/metrics/history validates range', async () => {
    const res = await request(app)
      .get('/api/v1/instagram/metrics/history?range=7d')
      .set('Authorization', `Bearer ${bearer()}`);
    expect(res.status).toBe(400);
  });

  it('GET /instagram/metrics/history returns series', async () => {
    const res = await request(app)
      .get('/api/v1/instagram/metrics/history?range=30d')
      .set('Authorization', `Bearer ${bearer()}`);
    expect(res.status).toBe(200);
    expect(res.body.series).toHaveLength(1);
  });
});
