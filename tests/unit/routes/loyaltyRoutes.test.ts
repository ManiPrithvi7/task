import express from 'express';
import request from 'supertest';
import { createLoyaltyRoutes } from '@/routes/loyaltyRoutes';
import { LoyaltyHttpError } from '@/utils/loyaltyErrors';
import type { LoyaltyService } from '@/services/loyaltyService';
import type { LoyaltyConfig } from '@/config/loyaltyConfig';

const loyalty: LoyaltyConfig = {
  ttlMs: 5000,
  sessionTtlMs: 45_000,
  ackTimeoutMs: 5000,
  createdSupersedeMs: 10_000,
  commandTtlMs: 10_000,
  spinSecret: 's3cret',
  previewOriginPattern: ''
};

function app(service: Partial<LoyaltyService>, env = 'test') {
  const a = express();
  a.use(express.json());
  a.use(
    '/loyalty',
    createLoyaltyRoutes({
      service: service as LoyaltyService,
      loyalty,
      env
    })
  );
  return a;
}

describe('loyaltyRoutes', () => {
  it('join 503 from service DEVICE_OFFLINE', async () => {
    const res = await request(
      app({
        join: jest.fn().mockRejectedValue(new LoyaltyHttpError(503, 'DEVICE_OFFLINE', 'Display offline'))
      })
    )
      .post('/loyalty/join')
      .send({ deviceId: 'DEVICE-17' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('DEVICE_OFFLINE');
  });

  it('rejects spin without X-Loyalty-Key when secret is configured', async () => {
    const spin = jest.fn();
    const res = await request(app({ spin }, 'production'))
      .post('/loyalty/spin')
      .send({
        sessionId: 'ls_1',
        idempotencyKey: 'k',
        spinId: 'spin_1',
        result: { digits: [1, 2, 3], value: '123', reward: 'X' }
      });
    expect(res.status).toBe(401);
    expect(spin).not.toHaveBeenCalled();
  });

  it('forwards result on spin 200', async () => {
    const result = { digits: [7, 7, 7], value: '777', reward: 'Free Item' };
    const res = await request(app({ spin: jest.fn().mockResolvedValue({ spinId: 'spin_1', status: 'command_published', result }) }))
      .post('/loyalty/spin')
      .set('X-Loyalty-Key', 's3cret')
      .send({
        sessionId: 'ls_1',
        idempotencyKey: 'k',
        spinId: 'spin_1',
        result
      });
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual(result);
  });

  it('does not construct loyalty service until join or spin', async () => {
    const getService = jest.fn(() => ({
      join: jest.fn().mockResolvedValue({ sessionId: 'ls_1', deviceId: 'DEVICE-17', expiresAt: 't' })
    })) as jest.Mock;
    const a = express();
    a.use(express.json());
    a.use(
      '/loyalty',
      createLoyaltyRoutes({
        getService: getService as () => LoyaltyService,
        tryService: () => undefined,
        loyalty,
        env: 'test'
      })
    );
    expect(getService).not.toHaveBeenCalled();
    const getRes = await request(a).get('/loyalty/spin/spin_1');
    expect(getRes.status).toBe(404);
    expect(getService).not.toHaveBeenCalled();
    const joinRes = await request(a).post('/loyalty/join').send({ deviceId: 'DEVICE-17' });
    expect(joinRes.status).toBe(201);
    expect(getService).toHaveBeenCalledTimes(1);
  });
});
