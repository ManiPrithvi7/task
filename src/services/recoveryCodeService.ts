/**
 * Factory-reset recovery codes stored in Redis (TTL + attempt limits).
 */

import * as crypto from 'crypto';
import { RedisClientType } from 'redis';
import { getRedisService } from './redisService';
import { logger } from '../utils/logger';

const RECOVERY_KEY = 'recovery:';

export interface RecoveryRedisState {
  code: string;
  used: boolean;
  attempts: number;
}

export type RecoveryCodeError =
  | 'CODE_EXPIRED'
  | 'CODE_USED'
  | 'RATE_LIMITED'
  | 'CODE_INVALID'
  | 'GENERATE_RATE_LIMITED'
  | 'REDIS_UNAVAILABLE';

const DEFAULT_TTL_SEC = 600;
const MAX_ATTEMPTS = 5;

export class RecoveryCodeService {
  constructor(
    private readonly keyPrefix: string,
    private readonly ttlSec: number = DEFAULT_TTL_SEC
  ) {}

  private recoveryKey(deviceId: string): string {
    return `${this.keyPrefix}${RECOVERY_KEY}${deviceId}`;
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
   * Returns remaining TTL (seconds) for an active recovery code.
   */
  async getActiveCodeTtl(deviceId: string): Promise<{ exists: true; ttlSec: number } | { exists: false } | { error: 'REDIS_UNAVAILABLE' }> {
    const redis = this.getRedis();
    if (!redis) {
      return { error: 'REDIS_UNAVAILABLE' };
    }

    const key = this.recoveryKey(deviceId);
    const raw = await redis.get(key);
    if (raw == null) {
      return { exists: false };
    }

    const ttl = await redis.ttl(key);
    // ttl: -2 key missing, -1 no expire; we always set EX on create, so treat <=0 as expired
    if (ttl <= 0) {
      return { exists: false };
    }
    return { exists: true, ttlSec: ttl };
  }

  /**
   * Creates a new code if none active. If a code is already active, does NOT rotate it
   * (one-call-per-10-min window), and returns GENERATE_RATE_LIMITED.
   */
  async generateCode(deviceId: string): Promise<{ code: string; expiresIn: number } | { error: RecoveryCodeError }> {
    const redis = this.getRedis();
    if (!redis) {
      return { error: 'REDIS_UNAVAILABLE' };
    }

    const active = await this.getActiveCodeTtl(deviceId);
    if ('error' in active) {
      return { error: active.error };
    }
    if (active.exists) {
      logger.warn('recovery generate-code blocked (active code exists)', { deviceId, ttlSec: active.ttlSec });
      return { error: 'GENERATE_RATE_LIMITED' };
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const state: RecoveryRedisState = { code, used: false, attempts: 0 };
    const key = this.recoveryKey(deviceId);
    await redis.setEx(key, this.ttlSec, JSON.stringify(state));
    logger.info('recovery code stored in redis', { deviceId, redisKey: key, ttlSec: this.ttlSec });

    return { code, expiresIn: this.ttlSec };
  }

  /**
   * Validate submitted code. On mismatch, increments attempts (preserves TTL).
   * On match, returns ok — caller must call markUsed after successful cert issuance.
   */
  async verifyCode(deviceId: string, submitted: string): Promise<{ ok: true } | { ok: false; error: RecoveryCodeError; message: string }> {
    const redis = this.getRedis();
    if (!redis) {
      return { ok: false, error: 'REDIS_UNAVAILABLE', message: 'Recovery service unavailable' };
    }

    const key = this.recoveryKey(deviceId);
    const raw = await redis.get(key);
    if (raw == null) {
      const ttl = await redis.ttl(key);
      logger.warn('recovery code not found in redis', { deviceId, redisKey: key, ttl });
      return { ok: false, error: 'CODE_EXPIRED', message: 'Recovery code expired or missing' };
    }

    let state: RecoveryRedisState;
    try {
      state = JSON.parse(raw) as RecoveryRedisState;
    } catch {
      await redis.del(key);
      return { ok: false, error: 'CODE_EXPIRED', message: 'Recovery code invalid' };
    }

    if (state.used === true) {
      return { ok: false, error: 'CODE_USED', message: 'Recovery code already used' };
    }
    if (state.attempts >= MAX_ATTEMPTS) {
      return { ok: false, error: 'RATE_LIMITED', message: 'Too many invalid attempts' };
    }

    const normalized = String(submitted ?? '').replace(/\s+/g, '').trim();
    if (state.code !== normalized) {
      state.attempts += 1;
      await redis.set(key, JSON.stringify(state), { KEEPTTL: true });
      logger.warn('recovery code mismatch', { deviceId, attempts: state.attempts });
      return { ok: false, error: 'CODE_INVALID', message: 'Invalid recovery code' };
    }

    return { ok: true };
  }

  async markUsed(deviceId: string): Promise<void> {
    const redis = this.getRedis();
    if (!redis) return;

    const key = this.recoveryKey(deviceId);
    const raw = await redis.get(key);
    if (raw == null) return;

    try {
      const state = JSON.parse(raw) as RecoveryRedisState;
      state.used = true;
      await redis.set(key, JSON.stringify(state), { KEEPTTL: true });
    } catch {
      await redis.del(key);
    }
  }
}

export function createRecoveryCodeService(
  keyPrefix: string,
  opts?: { ttlSec?: number }
): RecoveryCodeService {
  return new RecoveryCodeService(
    keyPrefix,
    opts?.ttlSec ?? parseInt(process.env.RECOVERY_CODE_TTL_SEC || '600', 10)
  );
}
