import * as jwt from 'jsonwebtoken';
import {
  DEVICE_RESET_RECOVERY_PURPOSE,
  RecoverySessionService
} from '@/services/recoverySessionService';

jest.mock('@/services/redisService', () => ({
  getRedisService: jest.fn()
}));

import { getRedisService } from '@/services/redisService';

const TEST_SECRET = 'test-auth-secret-for-recovery-session';
const TEST_USER = '507f1f77bcf86cd799439011';
const TEST_DEVICE = 'DEVICE-19';

function makeService(): RecoverySessionService {
  return new RecoverySessionService('mqtt-lite:', TEST_SECRET, 900);
}

function signTestToken(deviceId: string, userId: string, jti = 'test-jti-uuid'): string {
  return jwt.sign(
    {
      sub: userId,
      device_id: deviceId,
      jti,
      purpose: DEVICE_RESET_RECOVERY_PURPOSE
    },
    TEST_SECRET,
    { algorithm: 'HS256', expiresIn: 900 }
  );
}

function mockRedisClient(overrides: {
  get?: jest.Mock;
  ttl?: jest.Mock;
  setEx?: jest.Mock;
}) {
  const get = overrides.get ?? jest.fn().mockResolvedValue(null);
  const ttl = overrides.ttl ?? jest.fn().mockResolvedValue(-2);
  const setEx = overrides.setEx ?? jest.fn().mockResolvedValue('OK');
  (getRedisService as jest.Mock).mockReturnValue({
    isRedisConnected: () => true,
    getClient: () => ({ get, ttl, setEx })
  });
  return { get, ttl, setEx };
}

describe('RecoverySessionService.parseDeviceRecoveryToken', () => {
  const svc = makeService();

  it('accepts valid device recovery JWT', () => {
    const token = signTestToken('DEVICE-19', '507f1f77bcf86cd799439011');
    const r = svc.parseDeviceRecoveryToken(token, 'DEVICE-19');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims.jti).toBe('test-jti-uuid');
      expect(r.claims.device_id).toBe('DEVICE-19');
    }
  });

  it('rejects wrong device_id claim', () => {
    const token = signTestToken('DEVICE-19', '507f1f77bcf86cd799439011');
    const r = svc.parseDeviceRecoveryToken(token, 'DEVICE-20');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('TOKEN_CLAIM_MISMATCH');
    }
  });

  it('rejects wrong purpose', () => {
    const token = jwt.sign(
      { sub: '507f1f77bcf86cd799439011', device_id: 'DEVICE-19', jti: 'x', purpose: 'other' },
      TEST_SECRET,
      { algorithm: 'HS256', expiresIn: 900 }
    );
    const r = svc.parseDeviceRecoveryToken(token, 'DEVICE-19');
    expect(r.ok).toBe(false);
  });
});

describe('RecoverySessionService.registerSession', () => {
  const svc = makeService();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('stores a new session when none exists', async () => {
    const { setEx } = mockRedisClient({});
    const token = signTestToken(TEST_DEVICE, TEST_USER);

    const result = await svc.registerSession(TEST_DEVICE, token, TEST_USER);

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.expiresIn).toBe(900);
      expect(result.jti).toBe('test-jti-uuid');
    }
    expect(setEx).toHaveBeenCalledWith(
      'mqtt-lite:recovery:session:DEVICE-19',
      900,
      expect.stringContaining('"jti":"test-jti-uuid"')
    );
  });

  it('returns GENERATE_RATE_LIMITED when session exists and forceReissue is false', async () => {
    const existing = JSON.stringify({
      jti: 'old-jti',
      userId: TEST_USER,
      purpose: DEVICE_RESET_RECOVERY_PURPOSE,
      tokenHash: 'abc',
      createdAt: new Date().toISOString()
    });
    const { setEx } = mockRedisClient({
      get: jest.fn().mockResolvedValue(existing),
      ttl: jest.fn().mockResolvedValue(600)
    });
    const token = signTestToken(TEST_DEVICE, TEST_USER, 'new-jti');

    const result = await svc.registerSession(TEST_DEVICE, token, TEST_USER);

    expect(result).toEqual({ error: 'GENERATE_RATE_LIMITED' });
    expect(setEx).not.toHaveBeenCalled();
  });

  it('replaces session when forceReissue is true', async () => {
    const existing = JSON.stringify({
      jti: 'old-jti',
      userId: TEST_USER,
      purpose: DEVICE_RESET_RECOVERY_PURPOSE,
      tokenHash: 'abc',
      createdAt: new Date().toISOString()
    });
    const { setEx } = mockRedisClient({
      get: jest.fn().mockResolvedValue(existing),
      ttl: jest.fn().mockResolvedValue(600)
    });
    const token = signTestToken(TEST_DEVICE, TEST_USER, 'new-jti');

    const result = await svc.registerSession(TEST_DEVICE, token, TEST_USER, { forceReissue: true });

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.jti).toBe('new-jti');
    }
    expect(setEx).toHaveBeenCalledWith(
      'mqtt-lite:recovery:session:DEVICE-19',
      900,
      expect.stringContaining('"jti":"new-jti"')
    );
  });
});
