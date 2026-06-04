import * as jwt from 'jsonwebtoken';
import {
  DEVICE_RESET_RECOVERY_PURPOSE,
  RecoverySessionService
} from '@/services/recoverySessionService';

const TEST_SECRET = 'test-auth-secret-for-recovery-session';

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
