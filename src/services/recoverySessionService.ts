/**
 * Factory-reset recovery sessions in Redis (JWT binding + TTL + single-use).
 */

import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { RedisClientType } from 'redis';
import { getRedisService } from './redisService';
import { logger } from '../utils/logger';

const RECOVERY_SESSION_KEY = 'recovery:session:';
export const DEVICE_RESET_RECOVERY_PURPOSE = 'device-reset-recovery';

export interface RecoverySessionRedisState {
  jti: string;
  userId: string;
  purpose: string;
  tokenHash: string;
  createdAt: string;
}

export type RecoverySessionError =
  | 'SESSION_EXPIRED'
  | 'SESSION_INVALID'
  | 'RATE_LIMITED'
  | 'GENERATE_RATE_LIMITED'
  | 'REDIS_UNAVAILABLE'
  | 'TOKEN_INVALID'
  | 'TOKEN_CLAIM_MISMATCH';

const DEFAULT_TTL_SEC = 900;
const MAX_VERIFY_ATTEMPTS = 5;

export interface DeviceRecoveryJwtClaims {
  sub: string;
  device_id: string;
  jti: string;
  purpose: string;
  exp?: number;
  iat?: number;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token.trim()).digest('hex');
}

export class RecoverySessionService {
  constructor(
    private readonly keyPrefix: string,
    private readonly authSecret: string,
    private readonly ttlSec: number = DEFAULT_TTL_SEC
  ) {}

  private sessionKey(deviceId: string): string {
    return `${this.keyPrefix}${RECOVERY_SESSION_KEY}${deviceId}`;
  }

  private getRedis(): RedisClientType | null {
    const svc = getRedisService();
    if (!svc?.isRedisConnected()) {
      return null;
    }
    try {
      return svc.getClient();
    } catch {
      return null;
    }
  }

  isAvailable(): boolean {
    return this.getRedis() !== null;
  }

  /**
   * Decode and validate device recovery JWT claims (signature + purpose + device_id).
   */
  parseDeviceRecoveryToken(
    token: string,
    expectedDeviceId: string
  ): { ok: true; claims: DeviceRecoveryJwtClaims } | { ok: false; error: RecoverySessionError; message: string } {
    if (!token?.trim()) {
      return { ok: false, error: 'TOKEN_INVALID', message: 'Recovery token is required' };
    }
    if (!this.authSecret?.trim()) {
      return { ok: false, error: 'TOKEN_INVALID', message: 'Recovery token verification unavailable' };
    }

    try {
      const decoded = jwt.verify(token.trim(), this.authSecret, {
        algorithms: ['HS256']
      }) as DeviceRecoveryJwtClaims;

      const deviceId = String(decoded.device_id ?? '').trim();
      const jti = String(decoded.jti ?? '').trim();
      const purpose = String(decoded.purpose ?? '').trim();
      const sub = String(decoded.sub ?? '').trim();

      if (purpose !== DEVICE_RESET_RECOVERY_PURPOSE) {
        return { ok: false, error: 'TOKEN_CLAIM_MISMATCH', message: 'Invalid recovery token purpose' };
      }
      if (!deviceId || deviceId !== expectedDeviceId.trim()) {
        return { ok: false, error: 'TOKEN_CLAIM_MISMATCH', message: 'Recovery token device_id mismatch' };
      }
      if (!jti) {
        return { ok: false, error: 'TOKEN_INVALID', message: 'Recovery token missing jti' };
      }
      if (!sub) {
        return { ok: false, error: 'TOKEN_INVALID', message: 'Recovery token missing user subject' };
      }

      return { ok: true, claims: { ...decoded, sub, device_id: deviceId, jti, purpose } };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('expired')) {
        return { ok: false, error: 'SESSION_EXPIRED', message: 'Recovery token expired' };
      }
      return { ok: false, error: 'TOKEN_INVALID', message: 'Invalid recovery token' };
    }
  }

  async getActiveSessionTtl(
    deviceId: string
  ): Promise<{ exists: true; ttlSec: number } | { exists: false } | { error: 'REDIS_UNAVAILABLE' }> {
    const redis = this.getRedis();
    if (!redis) {
      return { error: 'REDIS_UNAVAILABLE' };
    }

    const key = this.sessionKey(deviceId);
    const raw = await redis.get(key);
    if (raw == null) {
      return { exists: false };
    }

    const ttl = await redis.ttl(key);
    if (ttl <= 0) {
      return { exists: false };
    }
    return { exists: true, ttlSec: ttl };
  }

  /**
   * Register a device recovery JWT session in Redis (one active session per device).
   * When forceReissue is true, an existing session is replaced instead of rate-limited.
   */
  async registerSession(
    deviceId: string,
    token: string,
    expectedUserId: string,
    opts?: { forceReissue?: boolean }
  ): Promise<{ expiresIn: number; jti: string } | { error: RecoverySessionError }> {
    const redis = this.getRedis();
    if (!redis) {
      return { error: 'REDIS_UNAVAILABLE' };
    }

    const active = await this.getActiveSessionTtl(deviceId);
    if ('error' in active) {
      return { error: active.error };
    }
    if (active.exists && !opts?.forceReissue) {
      logger.warn('recovery generate-session blocked (active session exists)', {
        deviceId,
        ttlSec: active.ttlSec
      });
      return { error: 'GENERATE_RATE_LIMITED' };
    }
    if (active.exists && opts?.forceReissue) {
      logger.info('recovery session replaced (force_reissue)', {
        deviceId,
        previousTtlSec: active.ttlSec
      });
    }

    const parsed = this.parseDeviceRecoveryToken(token, deviceId);
    if (!parsed.ok) {
      return { error: parsed.error };
    }

    if (parsed.claims.sub !== expectedUserId) {
      return { error: 'TOKEN_CLAIM_MISMATCH' };
    }

    const state: RecoverySessionRedisState = {
      jti: parsed.claims.jti,
      userId: parsed.claims.sub,
      purpose: parsed.claims.purpose,
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString()
    };

    const key = this.sessionKey(deviceId);
    await redis.setEx(key, this.ttlSec, JSON.stringify(state));
    logger.info('recovery session stored in redis', {
      deviceId,
      redisKey: key,
      ttlSec: this.ttlSec,
      jtiPrefix: parsed.claims.jti.slice(0, 8)
    });

    return { expiresIn: this.ttlSec, jti: parsed.claims.jti };
  }

  /**
   * Validate recovery JWT against Redis session. Caller must consumeSession after successful reissue.
   */
  async verifySession(
    deviceId: string,
    token: string
  ): Promise<{ ok: true; jti: string } | { ok: false; error: RecoverySessionError; message: string }> {
    const redis = this.getRedis();
    if (!redis) {
      return { ok: false, error: 'REDIS_UNAVAILABLE', message: 'Recovery service unavailable' };
    }

    const parsed = this.parseDeviceRecoveryToken(token, deviceId);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, message: parsed.message };
    }

    const key = this.sessionKey(deviceId);
    const raw = await redis.get(key);
    if (raw == null) {
      const ttl = await redis.ttl(key);
      logger.warn('recovery session not found in redis', { deviceId, redisKey: key, ttl });
      return { ok: false, error: 'SESSION_EXPIRED', message: 'Recovery session expired or missing' };
    }

    let state: RecoverySessionRedisState & { attempts?: number };
    try {
      state = JSON.parse(raw) as RecoverySessionRedisState & { attempts?: number };
    } catch {
      await redis.del(key);
      return { ok: false, error: 'SESSION_EXPIRED', message: 'Recovery session invalid' };
    }

    const attempts = state.attempts ?? 0;
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      return { ok: false, error: 'RATE_LIMITED', message: 'Too many invalid attempts' };
    }

    const tokenHash = hashToken(token);
    if (state.jti !== parsed.claims.jti || state.tokenHash !== tokenHash) {
      state.attempts = attempts + 1;
      await redis.set(key, JSON.stringify(state), { KEEPTTL: true });
      logger.warn('recovery session mismatch', {
        deviceId,
        attempts: state.attempts,
        jtiPrefix: parsed.claims.jti.slice(0, 8)
      });
      return { ok: false, error: 'SESSION_INVALID', message: 'Invalid recovery token' };
    }

    return { ok: true, jti: parsed.claims.jti };
  }

  /** Single-use: delete session after successful cert issuance. */
  async consumeSession(deviceId: string): Promise<void> {
    const redis = this.getRedis();
    if (!redis) return;
    const key = this.sessionKey(deviceId);
    await redis.del(key);
    logger.info('recovery session consumed', { deviceId, redisKey: key });
  }
}

export function createRecoverySessionService(
  keyPrefix: string,
  authSecret: string,
  opts?: { ttlSec?: number }
): RecoverySessionService {
  return new RecoverySessionService(
    keyPrefix,
    authSecret,
    opts?.ttlSec ?? parseInt(process.env.RECOVERY_SESSION_TTL_SEC || '900', 10)
  );
}
