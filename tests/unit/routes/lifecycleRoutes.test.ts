import express from 'express';
import request from 'supertest';
import { createLifecycleRoutes } from '@/routes/lifecycleRoutes';
import type { LifecycleDeps } from '@/routes/lifecycleRoutes';

jest.mock('@/models/Device', () => ({
  Device: {
    findOne: jest.fn(),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 })
  },
  DeviceStatus: { ACTIVE: 'ACTIVE' }
}));

import { Device } from '@/models/Device';

const mockFindOne = Device.findOne as jest.Mock;

function buildLifecycleRoutesApp(overrides?: Partial<LifecycleDeps>) {
  const app = express();
  app.use(express.json());

  const deps: LifecycleDeps = {
    caService: {
      signCSR: jest.fn(),
      getRootCACertificate: jest.fn().mockReturnValue('ca-pem'),
      revokeAllDeviceCertificates: jest.fn().mockResolvedValue(undefined)
    } as unknown as LifecycleDeps['caService'],
    recoverySessionService: {
      isAvailable: jest.fn().mockReturnValue(true),
      verifySession: jest.fn(),
      consumeSession: jest.fn().mockResolvedValue(undefined)
    } as unknown as LifecycleDeps['recoverySessionService'],
    ...overrides
  };

  app.use('/api/v1', createLifecycleRoutes(deps));
  return { app, deps };
}

describe('lifecycleRoutes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 400 when device_id missing on reissue', async () => {
    const { app } = buildLifecycleRoutesApp();
    const res = await request(app)
      .post('/api/v1/certificates/reissue')
      .send({ recovery_token: 'token-1' })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('DEVICE_ID_REQUIRED');
  });

  it('returns 400 when recovery_token missing on reissue', async () => {
    const { app } = buildLifecycleRoutesApp();
    const res = await request(app)
      .post('/api/v1/certificates/reissue')
      .send({ device_id: 'device-1' })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('RECOVERY_TOKEN_REQUIRED');
  });

  it('returns 503 when recovery storage unavailable', async () => {
    const { app } = buildLifecycleRoutesApp({
      recoverySessionService: {
        isAvailable: jest.fn().mockReturnValue(false)
      } as unknown as LifecycleDeps['recoverySessionService']
    });

    const res = await request(app)
      .post('/api/v1/certificates/reissue')
      .send({ device_id: 'device-1', recovery_token: 'token-1' })
      .expect(503);

    expect(res.body.code).toBe('REDIS_UNAVAILABLE');
  });

  it('returns 404 when device not found on reissue', async () => {
    mockFindOne.mockResolvedValue(null);
    const { app } = buildLifecycleRoutesApp();

    const res = await request(app)
      .post('/api/v1/certificates/reissue')
      .send({ device_id: 'missing-device', recovery_token: 'token-1' })
      .expect(404);

    expect(res.body.code).toBe('DEVICE_NOT_FOUND');
  });

  it('returns 400 when recovery session verification fails', async () => {
    mockFindOne.mockResolvedValue({
      clientId: 'device-1',
      businessId: '507f1f77bcf86cd799439011'
    });

    const { app, deps } = buildLifecycleRoutesApp();
    (deps.recoverySessionService.verifySession as jest.Mock).mockResolvedValue({
      ok: false,
      error: 'SESSION_EXPIRED',
      message: 'Session expired'
    });

    const res = await request(app)
      .post('/api/v1/certificates/reissue')
      .send({ device_id: 'device-1', recovery_token: 'expired-token' })
      .expect(410);

    expect(res.body.code).toBe('SESSION_EXPIRED');
  });
});
