/**
 * Redis-Based Token Store
 * Stores provisioning tokens with TTL support in Redis (cloud)
 * Provides persistent storage for device provisioning tokens
 * Uses official 'redis' package (node-redis)
 */

import * as crypto from 'crypto';
import { RedisClientType } from 'redis';
import { REDIS_KEYS } from '../constants/redisKeys';
import { getLocalProvCache } from '../services/localCaches';
import { getRedisService } from '../services/redisService';
import { logger } from '../utils/logger';

export interface TokenEntry {
  deviceId: string;
  token: string;
  expiresAt: number;
}

export class TokenStore {
  private redis: RedisClientType | null = null;
  private readonly TOKEN_PREFIX = 'token:';
  private readonly DEVICE_PREFIX = 'device:';
  /** SHA-256 of JWT — records one-time use after successful sign-csr until JWT exp */
  private readonly CONSUMED_PREFIX = 'prov:consumed:';

  // In-memory fallback storage
  private inMemoryStore: Map<string, { entry: TokenEntry; expiresAt: number }> = new Map();
  private inMemoryDeviceMap: Map<string, string> = new Map();
  private inMemoryConsumed: Map<string, number> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private useInMemory: boolean = false;

  constructor() {
    const redisService = getRedisService();
    if (redisService && redisService.isRedisConnected()) {
      logger.info('TokenStore initialized (Redis-based)');
      this.redis = redisService.getClient();
    } else {
      logger.warn('TokenStore initialized (In-Memory fallback - tokens not persistent across restarts)');
      this.useInMemory = true;
      this.startInMemoryCleanup();
    }
  }

  private getRedis(): RedisClientType | null {
    if (this.useInMemory) {
      return null;
    }

    if (!this.redis) {
      const redisService = getRedisService();
      if (!redisService || !redisService.isRedisConnected()) {
        return null;
      }
      this.redis = redisService.getClient();
    }
    return this.redis;
  }

  private startInMemoryCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, value] of this.inMemoryStore.entries()) {
        if (now > value.expiresAt) {
          this.inMemoryStore.delete(key);
          const deviceId = value.entry.deviceId;
          if (this.inMemoryDeviceMap.get(deviceId) === value.entry.token) {
            this.inMemoryDeviceMap.delete(deviceId);
          }
        }
      }
      for (const [h, exp] of this.inMemoryConsumed.entries()) {
        if (now > exp) {
          this.inMemoryConsumed.delete(h);
        }
      }
      const local = getLocalProvCache();
      for (const [token, entry] of local.tokens.entries()) {
        if (now > entry.expiresAt) {
          local.tokens.delete(token);
          if (local.deviceIndex.get(entry.deviceId) === token) {
            local.deviceIndex.delete(entry.deviceId);
          }
        }
      }
    }, 60000);
  }

  async setToken(token: string, deviceId: string, ttlSeconds: number, userId = ''): Promise<void> {
    try {
      const expiresAt = Date.now() + ttlSeconds * 1000;
      const createdAt = Date.now();
      const entry: TokenEntry = { deviceId, token, expiresAt };

      const local = getLocalProvCache();
      local.tokens.set(token, {
        deviceId,
        userId,
        consumed: false,
        consumedAt: 0,
        createdAt,
        expiresAt
      });
      local.deviceIndex.set(deviceId, token);

      const redis = this.getRedis();
      if (redis) {
        await redis.hSet(REDIS_KEYS.provToken(token), {
          deviceId,
          userId,
          consumed: '0',
          consumedAt: '',
          createdAt: String(createdAt),
          expiresAt: String(expiresAt)
        });
        await redis.expire(REDIS_KEYS.provToken(token), ttlSeconds);
      } else {
        this.inMemoryStore.set(`${this.TOKEN_PREFIX}${token}`, { entry, expiresAt });
        this.inMemoryDeviceMap.set(deviceId, token);
      }
      logger.debug('Token stored (local + prov HASH)', {
        deviceId,
        ttlSeconds,
        expiresAt: new Date(expiresAt).toISOString()
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to store token', { error: errorMessage });
      throw error;
    }
  }

  private async readProvHash(
    redis: RedisClientType,
    token: string
  ): Promise<{ deviceId: string; userId: string; consumed: boolean; expiresAt: number } | null> {
    const hash = await redis.hGetAll(REDIS_KEYS.provToken(token));
    if (!hash?.deviceId) return null;
    return {
      deviceId: hash.deviceId,
      userId: hash.userId || '',
      consumed: hash.consumed === '1',
      expiresAt: Number(hash.expiresAt) || 0
    };
  }

  async getDeviceByToken(token: string): Promise<string | null> {
    try {
      const local = getLocalProvCache();
      const cached = local.tokens.get(token);
      if (cached) {
        if (cached.consumed || Date.now() > cached.expiresAt) return null;
        return cached.deviceId;
      }

      const redis = this.getRedis();
      if (redis) {
        const hash = await this.readProvHash(redis, token);
        if (hash) {
          if (hash.consumed || Date.now() > hash.expiresAt) return null;
          local.tokens.set(token, {
            deviceId: hash.deviceId,
            userId: hash.userId,
            consumed: false,
            consumedAt: 0,
            createdAt: Date.now(),
            expiresAt: hash.expiresAt
          });
          local.deviceIndex.set(hash.deviceId, token);
          return hash.deviceId;
        }
        // Legacy STRING dual-read during migration.
        const data = await redis.get(`${this.TOKEN_PREFIX}${token}`);
        if (data) {
          const entry: TokenEntry = JSON.parse(data);
          if (Date.now() > entry.expiresAt) {
            await this.deleteToken(token);
            return null;
          }
          return entry.deviceId;
        }
      }
      const key = `${this.TOKEN_PREFIX}${token}`;
      const stored = this.inMemoryStore.get(key);
      if (!stored) return null;
      if (Date.now() > stored.expiresAt) {
        this.inMemoryStore.delete(key);
        this.inMemoryDeviceMap.delete(stored.entry.deviceId);
        return null;
      }
      return stored.entry.deviceId;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to get device by token', { error: errorMessage });
      return null;
    }
  }

  async getTokenByDevice(deviceId: string): Promise<string | null> {
    try {
      const local = getLocalProvCache();
      const token = local.deviceIndex.get(deviceId);
      if (token) {
        const entry = local.tokens.get(token);
        if (entry && !entry.consumed && Date.now() <= entry.expiresAt) return token;
      }

      const redis = this.getRedis();
      if (redis) {
        // Legacy device→token STRING dual-read during migration.
        const legacyToken = await redis.get(`${this.DEVICE_PREFIX}${deviceId}`);
        if (!legacyToken) return null;
        const entry = await redis.get(`${this.TOKEN_PREFIX}${legacyToken}`);
        if (!entry) {
          await this.deleteTokenByDevice(deviceId);
          return null;
        }
        return legacyToken;
      }
      const memToken = this.inMemoryDeviceMap.get(deviceId);
      if (!memToken) return null;
      const key = `${this.TOKEN_PREFIX}${memToken}`;
      const stored = this.inMemoryStore.get(key);
      if (!stored) {
        this.inMemoryDeviceMap.delete(deviceId);
        return null;
      }
      return memToken;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to get token by device', { error: errorMessage });
      return null;
    }
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  }

  async markTokenConsumed(token: string, ttlSeconds: number): Promise<void> {
    const ttl = Math.max(1, Math.floor(ttlSeconds));

    const local = getLocalProvCache();
    const entry = local.tokens.get(token);
    if (entry) {
      entry.consumed = true;
      entry.consumedAt = Date.now();
      local.dirtyTokens.add(token);
    }
    const redis = this.getRedis();
    if (redis) {
      try {
        await redis.hSet(REDIS_KEYS.provToken(token), {
          consumed: '1',
          consumedAt: String(Date.now())
        });
        await redis.expire(REDIS_KEYS.provToken(token), ttl);
      } catch (e) {
        logger.warn('prov HASH consume failed', {
          error: e instanceof Error ? e.message : e
        });
      }
    }
  }

  async isTokenConsumed(token: string): Promise<boolean> {
    try {
      const local = getLocalProvCache().tokens.get(token);
      if (local?.consumed) return true;
      const redis = this.getRedis();
      if (redis) {
        const hash = await this.readProvHash(redis, token);
        if (hash?.consumed) return true;
        // Legacy consumed STRING dual-read.
        const h = this.hashToken(token);
        const v = await redis.get(`${this.CONSUMED_PREFIX}${h}`);
        return v !== null;
      }
      const h = this.hashToken(token);
      const exp = this.inMemoryConsumed.get(h);
      if (exp === undefined) return false;
      if (Date.now() > exp) {
        this.inMemoryConsumed.delete(h);
        return false;
      }
      return true;
    } catch (error) {
      logger.error('isTokenConsumed failed', { error: error instanceof Error ? error.message : error });
      return false;
    }
  }

  async deleteToken(token: string): Promise<void> {
    try {
      const local = getLocalProvCache();
      const entry = local.tokens.get(token);
      if (entry) {
        local.tokens.delete(token);
        if (local.deviceIndex.get(entry.deviceId) === token) {
          local.deviceIndex.delete(entry.deviceId);
        }
      }
      const redis = this.getRedis();
      if (redis) {
        await redis.del(REDIS_KEYS.provToken(token));
        if (entry) await redis.del(`${this.DEVICE_PREFIX}${entry.deviceId}`);
        await redis.del(`${this.TOKEN_PREFIX}${token}`);
      } else {
        const key = `${this.TOKEN_PREFIX}${token}`;
        const stored = this.inMemoryStore.get(key);
        if (stored) {
          this.inMemoryStore.delete(key);
          this.inMemoryDeviceMap.delete(stored.entry.deviceId);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to delete token', { error: errorMessage });
      throw error;
    }
  }

  async deleteTokenByDevice(deviceId: string): Promise<void> {
    try {
      const local = getLocalProvCache();
      const token = local.deviceIndex.get(deviceId);
      if (token) {
        await this.deleteToken(token);
        return;
      }

      const redis = this.getRedis();
      if (redis) {
        const legacyToken = await redis.get(`${this.DEVICE_PREFIX}${deviceId}`);
        if (legacyToken) {
          await redis.del(`${this.TOKEN_PREFIX}${legacyToken}`);
          await redis.del(`${this.DEVICE_PREFIX}${deviceId}`);
          await redis.del(REDIS_KEYS.provToken(legacyToken));
        }
      } else {
        const memToken = this.inMemoryDeviceMap.get(deviceId);
        if (memToken) {
          this.inMemoryStore.delete(`${this.TOKEN_PREFIX}${memToken}`);
          this.inMemoryDeviceMap.delete(deviceId);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to delete token by device', { error: errorMessage });
      throw error;
    }
  }

  async hasActiveToken(deviceId: string): Promise<boolean> {
    try {
      const token = await this.getTokenByDevice(deviceId);
      return token !== null;
    } catch {
      return false;
    }
  }

  async getTokenEntry(token: string): Promise<TokenEntry | null> {
    try {
      const local = getLocalProvCache().tokens.get(token);
      if (local) {
        return { deviceId: local.deviceId, token, expiresAt: local.expiresAt };
      }

      const redis = this.getRedis();
      const key = `${this.TOKEN_PREFIX}${token}`;

      if (redis) {
        const hash = await this.readProvHash(redis, token);
        if (hash) {
          return { deviceId: hash.deviceId, token, expiresAt: hash.expiresAt };
        }
        const data = await redis.get(key);
        if (!data) return null;
        return JSON.parse(data);
      }
      const stored = this.inMemoryStore.get(key);
      if (!stored) return null;
      return stored.entry;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to get token entry', { error: errorMessage });
      return null;
    }
  }

  async cleanup(): Promise<void> {
    try {
      const stats = await this.getStats();
      logger.debug('TokenStore status', stats);
    } catch (error) {
      logger.error('Failed to get TokenStore stats', { error });
    }
  }

  private async scanKeyCount(pattern: string): Promise<number> {
    const redis = this.getRedis();
    if (!redis) return 0;
    let cursor = 0;
    let count = 0;
    do {
      const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = typeof result.cursor === 'number' ? result.cursor : Number(result.cursor);
      count += result.keys.length;
    } while (cursor !== 0);
    return count;
  }

  async getStats(): Promise<{
    tokenCount: number;
    deviceCount: number;
    connected: boolean;
    storage: 'redis' | 'memory';
  }> {
    try {
      const redis = this.getRedis();

      if (redis) {
        const tokenCount = await this.scanKeyCount('prov:*');
        return {
          tokenCount,
          deviceCount: getLocalProvCache().deviceIndex.size,
          connected: true,
          storage: 'redis'
        };
      } else {
        return {
          tokenCount: this.inMemoryStore.size,
          deviceCount: this.inMemoryDeviceMap.size,
          connected: true,
          storage: 'memory'
        };
      }
    } catch (error) {
      logger.error('Failed to get stats', { error });
      return {
        tokenCount: 0,
        deviceCount: 0,
        connected: false,
        storage: this.useInMemory ? 'memory' : 'redis'
      };
    }
  }

  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.inMemoryStore.clear();
    this.inMemoryDeviceMap.clear();
    this.inMemoryConsumed.clear();
    getLocalProvCache().clear();
    logger.info('TokenStore shutdown');
    this.redis = null;
  }
}

let tokenStore: TokenStore | null = null;

export function getTokenStore(): TokenStore {
  if (!tokenStore) {
    tokenStore = new TokenStore();
  }
  return tokenStore;
}
