/**
 * AuthService — Comprehensive Test Suite
 *
 * Priority coverage:
 *   P0: Failure-path message mapping (expired/signature/malformed)
 *   P0: UserId extraction precedence (sub > userId > id > user_id)
 *   P1: ObjectId format gate + boundary cases
 *   P1: Input validation (empty/whitespace/non-string)
 *   P2: Outer catch-all + constructor warning
 */


import * as jwt from 'jsonwebtoken';
import { AuthService } from '@/services/authService';
import { logger } from '@/utils/logger';

const TEST_SECRET = 'test-super-secret-key';
const VALID_USER_ID = '507f1f77bcf86cd799439011'; // 24 hex chars

describe('AuthService', () => {
  let authService: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    authService = new AuthService(TEST_SECRET);
  });

  /* ══════════════════════════════════════════════════════════════
   * P2: Constructor
   * ══════════════════════════════════════════════════════════════ */

  describe('constructor', () => {
    test('logs a warning if authSecret is empty', () => {
      new AuthService('');
      expect(logger.warn).toHaveBeenCalledWith(
        'AUTH_SECRET is empty or not set. Authentication will fail.'
      );
    });

    test('logs a warning if authSecret is whitespace-only', () => {
      new AuthService('   ');
      expect(logger.warn).toHaveBeenCalledWith(
        'AUTH_SECRET is empty or not set. Authentication will fail.'
      );
    });

    test('does not log a warning if authSecret is valid', () => {
      new AuthService(TEST_SECRET);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P1: Input Validation
   * ══════════════════════════════════════════════════════════════ */

  describe('input validation', () => {
    test('rejects empty string', async () => {
      const result = await authService.verifyAuthToken('');
      expect(result).toEqual({
        valid: false,
        error: 'auth_token is required and must be a non-empty string',
      });
    });

    test('rejects whitespace-only string', async () => {
      const result = await authService.verifyAuthToken('   ');
      expect(result).toEqual({
        valid: false,
        error: 'auth_token is required and must be a non-empty string',
      });
    });

    test('rejects non-string input (undefined)', async () => {
      const result = await authService.verifyAuthToken(
        undefined as unknown as string
      );
      expect(result).toEqual({
        valid: false,
        error: 'auth_token is required and must be a non-empty string',
      });
    });

    test('rejects non-string input (number)', async () => {
      const result = await authService.verifyAuthToken(
        12345 as unknown as string
      );
      expect(result).toEqual({
        valid: false,
        error: 'auth_token is required and must be a non-empty string',
      });
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P0: JWT Verification Failure Paths
   * ══════════════════════════════════════════════════════════════ */

  describe('JWT verification failure paths', () => {
    test('rejects expired token with specific message', async () => {
      const token = jwt.sign({ sub: VALID_USER_ID }, TEST_SECRET, {
        expiresIn: '-10s', // Expired 10 seconds ago
      });

      const result = await authService.verifyAuthToken(token);

      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'auth_token has expired. Please obtain a new token.'
      );
    });

    test('rejects tampered/wrong-secret token with signature message', async () => {
      const token = jwt.sign({ sub: VALID_USER_ID }, 'wrong-secret', {
        algorithm: 'HS256',
      });

      const result = await authService.verifyAuthToken(token);

      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'Invalid auth_token signature. Token may be tampered with or signed with wrong secret.'
      );
    });

    test('rejects malformed token', async () => {
      const result = await authService.verifyAuthToken('not.a.valid.jwt');

      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'Malformed auth_token. Token format is invalid.'
      );
    });

    test('rejects tokens with disallowed algorithm (e.g. HS384)', async () => {
      // Sign with HS384, but service only allows HS256
      const token = jwt.sign({ sub: VALID_USER_ID }, TEST_SECRET, {
        algorithm: 'HS384',
      });

      const result = await authService.verifyAuthToken(token);

      expect(result.valid).toBe(false);
      // Falls through to the generic Token verification failed message
      expect(result.error).toContain('Token verification failed:');
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P0: UserId Extraction Precedence & Success Paths
   * ══════════════════════════════════════════════════════════════ */

  describe('userId extraction precedence', () => {
    test('sub takes precedence over userId, id, and user_id', async () => {
      const token = jwt.sign(
        {
          sub: VALID_USER_ID,
          userId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
          id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
          user_id: 'cccccccccccccccccccccccc',
          email: 'test@example.com',
        },
        TEST_SECRET
      );

      const result = await authService.verifyAuthToken(token);

      expect(result.valid).toBe(true);
      expect(result.userId).toBe(VALID_USER_ID);
      expect(result.userEmail).toBe('test@example.com');
    });

    test('userId is used if sub is absent', async () => {
      const token = jwt.sign(
        { userId: VALID_USER_ID },
        TEST_SECRET
      );

      const result = await authService.verifyAuthToken(token);
      expect(result.valid).toBe(true);
      expect(result.userId).toBe(VALID_USER_ID);
    });

    test('id is used if sub and userId are absent', async () => {
      const token = jwt.sign({ id: VALID_USER_ID }, TEST_SECRET);

      const result = await authService.verifyAuthToken(token);
      expect(result.valid).toBe(true);
      expect(result.userId).toBe(VALID_USER_ID);
    });

    test('user_id is used if sub, userId, and id are absent', async () => {
      const token = jwt.sign({ user_id: VALID_USER_ID }, TEST_SECRET);

      const result = await authService.verifyAuthToken(token);
      expect(result.valid).toBe(true);
      expect(result.userId).toBe(VALID_USER_ID);
    });

    test('sets userEmail to undefined if email claim is absent', async () => {
      const token = jwt.sign({ sub: VALID_USER_ID }, TEST_SECRET);

      const result = await authService.verifyAuthToken(token);
      expect(result.valid).toBe(true);
      expect(result.userEmail).toBeUndefined();
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P1: Post-verify Payload Validation
   * ══════════════════════════════════════════════════════════════ */

  describe('post-verify payload validation', () => {
    test('rejects validly signed token if no userId fields exist', async () => {
      const token = jwt.sign({ email: 'test@example.com' }, TEST_SECRET);

      const result = await authService.verifyAuthToken(token);

      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'User ID not found in auth_token. Token must contain sub, userId, id, or user_id field.'
      );
      expect(result.decoded).toBeDefined();
    });

    test('rejects invalid userId format (alphabetic string)', async () => {
      const token = jwt.sign({ sub: 'user-123' }, TEST_SECRET);

      const result = await authService.verifyAuthToken(token);

      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'Invalid user ID format in auth_token. Expected MongoDB ObjectId format.'
      );
      expect(result.decoded).toBeDefined();
    });

    test('accepts boundary case: exactly 24 hex chars', async () => {
      const id = '0'.repeat(24);
      const token = jwt.sign({ sub: id }, TEST_SECRET);

      const result = await authService.verifyAuthToken(token);

      expect(result.valid).toBe(true);
      expect(result.userId).toBe(id);
    });

    test('rejects boundary case: 25 hex chars', async () => {
      const id = '0'.repeat(25);
      const token = jwt.sign({ sub: id }, TEST_SECRET);

      const result = await authService.verifyAuthToken(token);

      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'Invalid user ID format in auth_token. Expected MongoDB ObjectId format.'
      );
    });

    test('accepts uppercase hex chars in userId', async () => {
      const id = 'A'.repeat(24);
      const token = jwt.sign({ sub: id }, TEST_SECRET);

      const result = await authService.verifyAuthToken(token);

      expect(result.valid).toBe(true);
      expect(result.userId).toBe(id);
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P2: Catch-all paths (inner JWT vs outer try)
   * ══════════════════════════════════════════════════════════════ */

  describe('catch-all error paths', () => {
    test('jwt.verify unexpected Error maps via inner catch to Token verification failed', async () => {
      // jwt.verify errors always hit the inner catch — not the outer catch-all
      jest.spyOn(jwt, 'verify').mockImplementation(() => {
        throw new Error('boom');
      });

      const result = await authService.verifyAuthToken('some.token.here');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Token verification failed: boom');

      jest.restoreAllMocks();
    });

    test('unexpected throw before jwt.verify hits outer catch-all', async () => {
      // logger.debug runs before the inner jwt try — throwing here hits the outer catch
      jest.spyOn(logger, 'debug').mockImplementation(() => {
        throw new Error('boom');
      });

      const result = await authService.verifyAuthToken('some.token.here');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Authentication verification failed: boom');

      jest.restoreAllMocks();
    });
  });
});
