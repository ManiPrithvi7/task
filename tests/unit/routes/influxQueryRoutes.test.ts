import express from 'express';
import request from 'supertest';
import { createInfluxQueryRoutes } from '@/routes/influxQueryRoutes';

const mockVerify = jest.fn();

jest.mock('@/services/influxService', () => ({
  getInfluxService: () => null
}));

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1',
    createInfluxQueryRoutes({
      authService: { verifyAuthToken: mockVerify } as never
    })
  );
  return app;
}

describe('POST /api/v1/influx/query auth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('verifies a compliance token once and rejects a non-admin role', async () => {
    mockVerify.mockResolvedValue({
      valid: true,
      userId: '507f1f77bcf86cd799439011',
      decoded: { role: 'user' }
    });

    const res = await request(buildApp())
      .post('/api/v1/influx/query')
      .set('Authorization', 'Bearer tok')
      .set('X-Query-Scope', 'compliance')
      .send({ flux: 'from(bucket: "metrics")' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');
    expect(mockVerify).toHaveBeenCalledTimes(1);
  });

  it('verifies an admin compliance token once', async () => {
    mockVerify.mockResolvedValue({
      valid: true,
      userId: '507f1f77bcf86cd799439011',
      decoded: { role: 'admin' }
    });

    const res = await request(buildApp())
      .post('/api/v1/influx/query')
      .set('Authorization', 'Bearer tok')
      .set('X-Query-Scope', 'compliance')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('QUERY_REQUIRED');
    expect(mockVerify).toHaveBeenCalledTimes(1);
  });
});
