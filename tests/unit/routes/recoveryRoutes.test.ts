import express from 'express';
import request from 'supertest';
import { createRecoveryRoutes } from '@/routes/recoveryRoutes';
import type { RecoveryRoutesDeps } from '@/routes/recoveryRoutes';

jest.mock('@/models/Device', () => ({
  Device: {
    findOne: jest.fn()
  }
}));

import { Device } from '@/models/Device';

const mockFindOne = Device.findOne as jest.Mock;

function buildRecoveryRoutesApp(overrides?: Partial<RecoveryRoutesDeps>) {
  const app = express();
  app.use(express.json());

  const deps: RecoveryRoutesDeps = {
    recoverySessionService: {
      isAvailable: jest.fn().mockReturnValue(true),
      registerSession: jest.fn().mockResolvedValue({ expiresIn: 900, jti: 'jti-123' }),
      getActiveSessionTtl: jest.fn()
    } as unknown as RecoveryRoutesDeps['recoverySessionService'],
    authService: {
      verifyAuthToken: jest.fn().mockResolvedValue({ valid: true, userId: '507f1f77bcf86cd799439011' })
    } as unknown as RecoveryRoutesDeps['authService'],
    ...overrides
  };

  app.use('/api/v1', createRecoveryRoutes(deps));
  return { app, deps };
}

describe('recoveryRoutes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 503 when recovery storage unavailable', async () => {
    const { app } = buildRecoveryRoutesApp({
      recoverySessionService: {
        isAvailable: jest.fn().mockReturnValue(false)
      } as unknown as RecoveryRoutesDeps['recoverySessionService']
    });

    const res = await request(app)
      .post('/api/v1/recovery/generate-session')
      .set('Authorization', 'Bearer user-token')
      .send({ device_id: 'device-1', token: 'recovery-jwt' })
      .expect(503);

    expect(res.body.code).toBe('REDIS_UNAVAILABLE');
  });

  it('returns 401 when user auth token missing', async () => {
    const { app } = buildRecoveryRoutesApp();
    const res = await request(app)
      .post('/api/v1/recovery/generate-session')
      .send({ device_id: 'device-1', token: 'recovery-jwt' })
      .expect(401);

    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 when user auth token invalid', async () => {
    const { app, deps } = buildRecoveryRoutesApp();
    (deps.authService.verifyAuthToken as jest.Mock).mockResolvedValue({
      valid: false,
      error: 'Invalid token'
    });

    const res = await request(app)
      .post('/api/v1/recovery/generate-session')
      .set('Authorization', 'Bearer invalid-token')
      .send({ device_id: 'device-1', token: 'recovery-jwt' })
      .expect(401);

    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('returns 400 when device_id missing', async () => {
    const { app } = buildRecoveryRoutesApp();
    const res = await request(app)
      .post('/api/v1/recovery/generate-session')
      .set('Authorization', 'Bearer user-token')
      .send({ token: 'recovery-jwt' })
      .expect(400);

    expect(res.body.code).toBe('DEVICE_ID_REQUIRED');
  });

  it('returns 400 when recovery token missing', async () => {
    const { app } = buildRecoveryRoutesApp();
    const res = await request(app)
      .post('/api/v1/recovery/generate-session')
      .set('Authorization', 'Bearer user-token')
      .send({ device_id: 'device-1' })
      .expect(400);

    expect(res.body.code).toBe('TOKEN_REQUIRED');
  });

  it('returns 404 when device not found', async () => {
    mockFindOne.mockResolvedValue(null);
    const { app } = buildRecoveryRoutesApp();

    const res = await request(app)
      .post('/api/v1/recovery/generate-session')
      .set('Authorization', 'Bearer user-token')
      .send({ device_id: 'missing-device', token: 'recovery-jwt' })
      .expect(404);

    expect(res.body.code).toBe('DEVICE_NOT_FOUND');
  });

  it('returns 200 when recovery session is registered', async () => {
    mockFindOne.mockResolvedValue({
      clientId: 'device-1',
      userId: '507f1f77bcf86cd799439011'
    });

    const { app, deps } = buildRecoveryRoutesApp();
    const res = await request(app)
      .post('/api/v1/recovery/generate-session')
      .set('Authorization', 'Bearer user-token')
      .send({ device_id: 'device-1', token: 'recovery-jwt' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.device_id).toBe('device-1');
    expect(res.body.expires_in).toBe(900);
    expect(deps.recoverySessionService.registerSession).toHaveBeenCalledWith(
      'device-1',
      'recovery-jwt',
      '507f1f77bcf86cd799439011',
      { forceReissue: false }
    );
  });

  it('forwards force_reissue: true to registerSession', async () => {
    mockFindOne.mockResolvedValue({
      clientId: 'DEVICE-19',
      userId: '507f1f77bcf86cd799439011'
    });

    const { app, deps } = buildRecoveryRoutesApp();
    const res = await request(app)
      .post('/api/v1/recovery/generate-session')
      .set('Authorization', 'Bearer user-jwt')
      .send({
        device_id: 'DEVICE-19',
        token: 'recovery-jwt',
        force_reissue: true
      })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(deps.recoverySessionService.registerSession).toHaveBeenCalledWith(
      'DEVICE-19',
      'recovery-jwt',
      '507f1f77bcf86cd799439011',
      { forceReissue: true }
    );
  });

  it('returns 429 when registerSession is rate limited', async () => {
    mockFindOne.mockResolvedValue({
      clientId: 'DEVICE-19',
      userId: '507f1f77bcf86cd799439011'
    });

    const { app, deps } = buildRecoveryRoutesApp({
      recoverySessionService: {
        isAvailable: jest.fn().mockReturnValue(true),
        registerSession: jest.fn().mockResolvedValue({ error: 'GENERATE_RATE_LIMITED' }),
        getActiveSessionTtl: jest.fn().mockResolvedValue({ exists: true, ttlSec: 420 })
      } as unknown as RecoveryRoutesDeps['recoverySessionService']
    });

    const res = await request(app)
      .post('/api/v1/recovery/generate-session')
      .set('Authorization', 'Bearer user-jwt')
      .send({
        device_id: 'DEVICE-19',
        token: 'recovery-jwt'
      })
      .expect(429);

    expect(res.body.code).toBe('GENERATE_RATE_LIMITED');
    expect(res.body.expires_in).toBe(420);
    expect(deps.recoverySessionService.getActiveSessionTtl).toHaveBeenCalledWith('DEVICE-19');
  });
});
