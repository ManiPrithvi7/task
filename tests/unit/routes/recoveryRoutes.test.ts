import express from 'express';
import request from 'supertest';
import { createRecoveryRoutes } from '@/routes/recoveryRoutes';

const mockRegisterSession = jest.fn();
const mockIsAvailable = jest.fn().mockReturnValue(true);
const mockGetActiveSessionTtl = jest.fn();
const mockVerifyAuthToken = jest.fn();

jest.mock('@/models/Device', () => ({
  Device: {
    findOne: jest.fn().mockResolvedValue({
      clientId: 'DEVICE-19',
      userId: '507f1f77bcf86cd799439011'
    })
  }
}));

function app() {
  const a = express();
  a.use(express.json());
  a.use(
    '/api/v1',
    createRecoveryRoutes({
      recoverySessionService: {
        isAvailable: mockIsAvailable,
        registerSession: mockRegisterSession,
        getActiveSessionTtl: mockGetActiveSessionTtl
      } as never,
      authService: {
        verifyAuthToken: mockVerifyAuthToken
      } as never
    })
  );
  return a;
}

describe('recoveryRoutes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAvailable.mockReturnValue(true);
    mockVerifyAuthToken.mockResolvedValue({
      valid: true,
      userId: '507f1f77bcf86cd799439011'
    });
    mockRegisterSession.mockResolvedValue({ expiresIn: 900, jti: 'test-jti-uuid' });
  });

  it('forwards force_reissue: true to registerSession', async () => {
    const res = await request(app())
      .post('/api/v1/recovery/generate-session')
      .set('Authorization', 'Bearer user-jwt')
      .send({
        device_id: 'DEVICE-19',
        token: 'recovery-jwt',
        force_reissue: true
      });

    expect(res.status).toBe(200);
    expect(mockRegisterSession).toHaveBeenCalledWith(
      'DEVICE-19',
      'recovery-jwt',
      '507f1f77bcf86cd799439011',
      { forceReissue: true }
    );
  });

  it('passes forceReissue false when flag is omitted', async () => {
    const res = await request(app())
      .post('/api/v1/recovery/generate-session')
      .set('Authorization', 'Bearer user-jwt')
      .send({
        device_id: 'DEVICE-19',
        token: 'recovery-jwt'
      });

    expect(res.status).toBe(200);
    expect(mockRegisterSession).toHaveBeenCalledWith(
      'DEVICE-19',
      'recovery-jwt',
      '507f1f77bcf86cd799439011',
      { forceReissue: false }
    );
  });

  it('returns 429 when registerSession is rate limited', async () => {
    mockRegisterSession.mockResolvedValue({ error: 'GENERATE_RATE_LIMITED' });
    mockGetActiveSessionTtl.mockResolvedValue({ exists: true, ttlSec: 420 });

    const res = await request(app())
      .post('/api/v1/recovery/generate-session')
      .set('Authorization', 'Bearer user-jwt')
      .send({
        device_id: 'DEVICE-19',
        token: 'recovery-jwt'
      });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('GENERATE_RATE_LIMITED');
    expect(res.body.expires_in).toBe(420);
  });
});
