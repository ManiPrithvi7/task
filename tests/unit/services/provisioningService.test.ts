/**
 * ProvisioningService — P0 security-boundary coverage
 *
 * Focus: JWT verification matrix, single-use consumed markers, user binding,
 * issueToken mutex / 409, peek vs download validation modes.
 *
 * Defects pinned (documented behavior):
 *   #1 isConsumed fail-open when store throws
 *   #2 allowMissingInStore grants validity without consumed check
 */

jest.mock('@/utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const mockTokenStore = {
  getTokenByDevice: jest.fn(),
  setToken: jest.fn(),
  getDeviceByToken: jest.fn(),
  isTokenConsumed: jest.fn(),
  deleteToken: jest.fn(),
  markTokenConsumed: jest.fn(),
  hasActiveToken: jest.fn(),
  getStats: jest.fn(),
};

jest.mock('@/storage/tokenStore', () => ({
  getTokenStore: jest.fn(() => mockTokenStore),
  TokenStore: jest.fn(),
}));

import * as jwt from 'jsonwebtoken';
import {
  ProvisioningService,
  ProvisioningTokenPayload,
} from '@/services/provisioningService';
import { logger } from '@/utils/logger';

const TEST_SECRET = 'provisioning-test-secret';
const TEST_USER = '507f1f77bcf86cd799439011';
const TEST_DEVICE = 'DEVICE-PROV-01';
const TOKEN_TTL = 300;

function makeService(): ProvisioningService {
  return new ProvisioningService({ jwtSecret: TEST_SECRET, tokenTTL: TOKEN_TTL });
}

function signProvisioningToken(
  overrides: Partial<ProvisioningTokenPayload> = {},
  secret = TEST_SECRET
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: ProvisioningTokenPayload = {
    device_id: TEST_DEVICE,
    user_id: TEST_USER,
    type: 'provisioning',
    iat: now,
    exp: now + TOKEN_TTL,
    ...overrides,
  };
  return jwt.sign(payload, secret, { algorithm: 'HS256' });
}

describe('ProvisioningService', () => {
  let svc: ProvisioningService;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = makeService();
    mockTokenStore.getTokenByDevice.mockResolvedValue(null);
    mockTokenStore.setToken.mockResolvedValue(undefined);
    mockTokenStore.getDeviceByToken.mockResolvedValue(TEST_DEVICE);
    mockTokenStore.isTokenConsumed.mockResolvedValue(false);
    mockTokenStore.deleteToken.mockResolvedValue(undefined);
    mockTokenStore.markTokenConsumed.mockResolvedValue(undefined);
    mockTokenStore.hasActiveToken.mockResolvedValue(false);
    mockTokenStore.getStats.mockResolvedValue({
      tokenCount: 0,
      deviceCount: 0,
      connected: true,
      storage: 'memory',
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P0: validateTokenWithoutRevoke — JWT failure paths
   * ══════════════════════════════════════════════════════════════ */

  describe('validateTokenWithoutRevoke — JWT failures', () => {
    test('rejects expired token', async () => {
      const token = jwt.sign(
        {
          device_id: TEST_DEVICE,
          user_id: TEST_USER,
          type: 'provisioning',
        },
        TEST_SECRET,
        { algorithm: 'HS256', expiresIn: '-10s' }
      );

      const result = await svc.validateTokenWithoutRevoke(token);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Token expired');
    });

    test('rejects invalid signature', async () => {
      const token = signProvisioningToken({}, 'wrong-secret');

      const result = await svc.validateTokenWithoutRevoke(token);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid token signature');
    });

    test('rejects malformed token', async () => {
      const result = await svc.validateTokenWithoutRevoke('not.a.valid.jwt');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid token format');
    });

    test('rejects non-provisioning token type', async () => {
      const token = jwt.sign(
        { device_id: TEST_DEVICE, user_id: TEST_USER, type: 'other' },
        TEST_SECRET,
        { algorithm: 'HS256', expiresIn: TOKEN_TTL }
      );

      const result = await svc.validateTokenWithoutRevoke(token);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid token type');
    });

    test('rejects when explicit exp check finds past expiration', async () => {
      const token = signProvisioningToken();
      const verifySpy = jest.spyOn(jwt, 'verify').mockReturnValue({
        device_id: TEST_DEVICE,
        user_id: TEST_USER,
        type: 'provisioning',
        iat: Math.floor(Date.now() / 1000) - 600,
        exp: Math.floor(Date.now() / 1000) - 1,
      } as ProvisioningTokenPayload);

      const result = await svc.validateTokenWithoutRevoke(token);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Token expired');
      verifySpy.mockRestore();
    });

    test('maps other jwt.verify errors to Token verification failed', async () => {
      const verifySpy = jest.spyOn(jwt, 'verify').mockImplementation(() => {
        throw new Error('unexpected jwt failure');
      });

      const result = await svc.validateTokenWithoutRevoke('some.token.here');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Token verification failed: unexpected jwt failure');
      verifySpy.mockRestore();
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P0: validateTokenWithoutRevoke — success + store matrix
   * ══════════════════════════════════════════════════════════════ */

  describe('validateTokenWithoutRevoke — store and binding', () => {
    test('accepts valid token with matching store entry and user_id', async () => {
      const token = signProvisioningToken();

      const result = await svc.validateTokenWithoutRevoke(token);

      expect(result).toEqual({
        valid: true,
        deviceId: TEST_DEVICE,
        userId: TEST_USER,
      });
    });

    test('rejects consumed token for sign-csr path', async () => {
      const token = signProvisioningToken();
      mockTokenStore.isTokenConsumed.mockResolvedValue(true);

      const result = await svc.validateTokenWithoutRevoke(token);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('already used after successful certificate issuance');
      expect(mockTokenStore.getDeviceByToken).not.toHaveBeenCalled();
    });

    test('rejects when token store lookup throws', async () => {
      const token = signProvisioningToken();
      mockTokenStore.getDeviceByToken.mockRejectedValue(new Error('redis down'));

      const result = await svc.validateTokenWithoutRevoke(token);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Token store unavailable');
    });

    test('rejects missing-in-store token with memory hint', async () => {
      const token = signProvisioningToken();
      mockTokenStore.getDeviceByToken.mockResolvedValue(null);

      const result = await svc.validateTokenWithoutRevoke(token);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Token not found in system');
      expect(result.error).toContain('in-memory store was reset');
    });

    test('rejects missing-in-store token with redis hint (no memory note)', async () => {
      const token = signProvisioningToken();
      mockTokenStore.getDeviceByToken.mockResolvedValue(null);
      mockTokenStore.getStats.mockResolvedValue({
        tokenCount: 1,
        deviceCount: 1,
        connected: true,
        storage: 'redis',
      });

      const result = await svc.validateTokenWithoutRevoke(token);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Token not found in system');
      expect(result.error).not.toContain('in-memory store was reset');
    });

    test('rejects device ID mismatch between JWT and store', async () => {
      const token = signProvisioningToken();
      mockTokenStore.getDeviceByToken.mockResolvedValue('OTHER-DEVICE');

      const result = await svc.validateTokenWithoutRevoke(token);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Device ID mismatch');
    });

    test('rejects when user_id missing from payload', async () => {
      const token = jwt.sign(
        { device_id: TEST_DEVICE, type: 'provisioning' },
        TEST_SECRET,
        { algorithm: 'HS256', expiresIn: TOKEN_TTL }
      );

      const result = await svc.validateTokenWithoutRevoke(token);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('User ID not found in token payload');
    });

    test('allows consumed token when allowConsumed is true', async () => {
      const token = signProvisioningToken();
      mockTokenStore.isTokenConsumed.mockResolvedValue(true);

      const result = await svc.validateTokenWithoutRevoke(token, { allowConsumed: true });

      expect(result.valid).toBe(true);
      expect(result.deviceId).toBe(TEST_DEVICE);
      expect(result.userId).toBe(TEST_USER);
    });

    test('allows missing-in-store when consumed marker is set (requires allowConsumed)', async () => {
      const token = signProvisioningToken();
      mockTokenStore.isTokenConsumed.mockResolvedValue(true);
      mockTokenStore.getDeviceByToken.mockResolvedValue(null);

      const result = await svc.validateTokenWithoutRevoke(token, { allowConsumed: true });

      expect(result.valid).toBe(true);
      expect(result.deviceId).toBe(TEST_DEVICE);
      expect(result.userId).toBe(TEST_USER);
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P0: Documented defects
   * ══════════════════════════════════════════════════════════════ */

  describe('documented security tradeoffs (defect pins)', () => {
    test('defect #1: isConsumed store failure is fail-open (treats as not consumed)', async () => {
      const token = signProvisioningToken();
      mockTokenStore.isTokenConsumed.mockRejectedValue(new Error('redis timeout'));

      const result = await svc.validateTokenWithoutRevoke(token);

      expect(result.valid).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        'Consumed marker lookup failed (treating as not consumed)',
        expect.objectContaining({ error: 'redis timeout' })
      );
    });

    test('defect #2: allowMissingInStore grants validity without consumed verification', async () => {
      const token = signProvisioningToken();
      mockTokenStore.getDeviceByToken.mockResolvedValue(null);
      mockTokenStore.isTokenConsumed.mockResolvedValue(false);

      const result = await svc.validateTokenWithoutRevoke(token, { allowMissingInStore: true });

      expect(result.valid).toBe(true);
      expect(result.deviceId).toBe(TEST_DEVICE);
      expect(result.userId).toBe(TEST_USER);
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P0: peekToken / peekTokenForDownload
   * ══════════════════════════════════════════════════════════════ */

  describe('peekToken / peekTokenForDownload', () => {
    test('peekToken rejects consumed tokens', async () => {
      const token = signProvisioningToken();
      mockTokenStore.isTokenConsumed.mockResolvedValue(true);

      const result = await svc.peekToken(token);

      expect(result.valid).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        'Provisioning token peek failed',
        expect.objectContaining({ error: expect.stringContaining('already used') })
      );
    });

    test('peekToken logs info on success', async () => {
      const token = signProvisioningToken();

      const result = await svc.peekToken(token);

      expect(result.valid).toBe(true);
      expect(logger.info).toHaveBeenCalledWith(
        'Provisioning token peeked (read-only)',
        expect.objectContaining({ deviceId: TEST_DEVICE, userId: TEST_USER })
      );
    });

    test('peekTokenForDownload allows consumed + missing-in-store', async () => {
      const token = signProvisioningToken();
      mockTokenStore.isTokenConsumed.mockResolvedValue(true);
      mockTokenStore.getDeviceByToken.mockResolvedValue(null);

      const result = await svc.peekTokenForDownload(token);

      expect(result.valid).toBe(true);
      expect(result.deviceId).toBe(TEST_DEVICE);
      expect(result.userId).toBe(TEST_USER);
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P0: issueToken
   * ══════════════════════════════════════════════════════════════ */

  describe('issueToken', () => {
    test('issues fresh token with correct payload and store write', async () => {
      const before = Math.floor(Date.now() / 1000);

      const token = await svc.issueToken(TEST_DEVICE, TEST_USER);

      const decoded = jwt.verify(token, TEST_SECRET) as ProvisioningTokenPayload;
      expect(decoded.device_id).toBe(TEST_DEVICE);
      expect(decoded.user_id).toBe(TEST_USER);
      expect(decoded.type).toBe('provisioning');
      expect(decoded.iat).toBeGreaterThanOrEqual(before);
      expect(decoded.exp).toBe(decoded.iat + TOKEN_TTL);
      expect(mockTokenStore.setToken).toHaveBeenCalledWith(token, TEST_DEVICE, TOKEN_TTL);
    });

    test('throws 409 when active valid token already exists', async () => {
      const existing = signProvisioningToken();
      mockTokenStore.getTokenByDevice.mockResolvedValue(existing);

      await expect(svc.issueToken(TEST_DEVICE, TEST_USER)).rejects.toMatchObject({
        message: 'Active provisioning token already exists',
        statusCode: 409,
        details: expect.objectContaining({
          message: 'A provisioning token for this device is already active.',
          expiresAt: expect.any(String),
          expiresInSeconds: expect.any(Number),
          token: existing,
        }),
      });
      expect(mockTokenStore.setToken).not.toHaveBeenCalled();
    });

    test('floors expiresInSeconds at 0 when active token expires within the same second', async () => {
      const existing = signProvisioningToken();
      mockTokenStore.getTokenByDevice.mockResolvedValue(existing);
      mockTokenStore.getDeviceByToken.mockResolvedValue(TEST_DEVICE);
      const nowSec = Math.floor(Date.now() / 1000);
      const decodeSpy = jest.spyOn(jwt, 'decode').mockReturnValue({
        device_id: TEST_DEVICE,
        user_id: TEST_USER,
        type: 'provisioning',
        iat: nowSec - TOKEN_TTL,
        exp: nowSec,
      } as ProvisioningTokenPayload);

      await expect(svc.issueToken(TEST_DEVICE, TEST_USER)).rejects.toMatchObject({
        statusCode: 409,
        details: expect.objectContaining({ expiresInSeconds: 0 }),
      });
      decodeSpy.mockRestore();
    });

    test('revokes existing token without decodable exp and issues fresh one', async () => {
      const existing = jwt.sign(
        { device_id: TEST_DEVICE, user_id: TEST_USER, type: 'provisioning' },
        TEST_SECRET,
        { algorithm: 'HS256', noTimestamp: true }
      );
      mockTokenStore.getTokenByDevice.mockResolvedValue(existing);
      mockTokenStore.getDeviceByToken.mockResolvedValue(TEST_DEVICE);

      const token = await svc.issueToken(TEST_DEVICE, TEST_USER);

      expect(mockTokenStore.deleteToken).toHaveBeenCalledWith(existing);
      expect(jwt.verify(token, TEST_SECRET)).toBeTruthy();
      expect(mockTokenStore.setToken).toHaveBeenCalled();
    });

    test('revokes invalid existing token and issues fresh one', async () => {
      const existing = signProvisioningToken({}, 'wrong-secret');
      mockTokenStore.getTokenByDevice.mockResolvedValue(existing);

      const token = await svc.issueToken(TEST_DEVICE, TEST_USER);

      expect(mockTokenStore.deleteToken).toHaveBeenCalledWith(existing);
      expect(jwt.verify(token, TEST_SECRET)).toBeTruthy();
    });

    test('serializes concurrent issueToken for same device (mutex)', async () => {
      const order: string[] = [];
      mockTokenStore.setToken.mockImplementation(async () => {
        order.push('start');
        await new Promise((r) => setTimeout(r, 30));
        order.push('end');
      });

      await Promise.all([
        svc.issueToken(TEST_DEVICE, TEST_USER),
        svc.issueToken(TEST_DEVICE, TEST_USER),
      ]);

      expect(order).toEqual(['start', 'end', 'start', 'end']);
    });

    test('rethrows issuance errors after logging', async () => {
      mockTokenStore.setToken.mockRejectedValue(new Error('store write failed'));

      await expect(svc.issueToken(TEST_DEVICE, TEST_USER)).rejects.toThrow('store write failed');
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to issue provisioning token',
        expect.objectContaining({ deviceId: TEST_DEVICE, userId: TEST_USER })
      );
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P1: revokeToken / finalize / delegation
   * ══════════════════════════════════════════════════════════════ */

  describe('revokeToken', () => {
    test('deletes token when found in store', async () => {
      const token = signProvisioningToken();
      mockTokenStore.getDeviceByToken.mockResolvedValue(TEST_DEVICE);

      await svc.revokeToken(token);

      expect(mockTokenStore.deleteToken).toHaveBeenCalledWith(token);
      expect(mockTokenStore.markTokenConsumed).not.toHaveBeenCalled();
    });

    test('warns when token not found (no rethrow)', async () => {
      mockTokenStore.getDeviceByToken.mockResolvedValue(null);

      await expect(svc.revokeToken('missing-token')).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith('Token not found for revocation');
    });

    test('logs store errors without rethrowing', async () => {
      mockTokenStore.getDeviceByToken.mockRejectedValue(new Error('store down'));

      await expect(svc.revokeToken('any')).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to revoke provisioning token',
        expect.objectContaining({ error: 'store down' })
      );
    });
  });

  describe('finalizeTokenAfterSuccessfulSignCsr', () => {
    test('marks consumed with remaining JWT TTL', async () => {
      const token = signProvisioningToken();
      const decoded = jwt.decode(token) as ProvisioningTokenPayload;
      const expectedTtl = Math.max(1, decoded.exp - Math.floor(Date.now() / 1000));

      await svc.finalizeTokenAfterSuccessfulSignCsr(token);

      expect(mockTokenStore.markTokenConsumed).toHaveBeenCalledWith(token, expectedTtl);
    });

    test('falls back to config tokenTTL when decode fails', async () => {
      const decodeSpy = jest.spyOn(jwt, 'decode').mockImplementation(() => {
        throw new Error('decode failed');
      });

      await svc.finalizeTokenAfterSuccessfulSignCsr('bad-token');

      expect(mockTokenStore.markTokenConsumed).toHaveBeenCalledWith('bad-token', TOKEN_TTL);
      decodeSpy.mockRestore();
    });
  });

  describe('delegation helpers', () => {
    test('hasActiveToken delegates to token store', async () => {
      mockTokenStore.hasActiveToken.mockResolvedValue(true);

      await expect(svc.hasActiveToken(TEST_DEVICE)).resolves.toBe(true);
      expect(mockTokenStore.hasActiveToken).toHaveBeenCalledWith(TEST_DEVICE);
    });

    test('getTokenTTL returns config value', () => {
      expect(svc.getTokenTTL()).toBe(TOKEN_TTL);
    });
  });
});
