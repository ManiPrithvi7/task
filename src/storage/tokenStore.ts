/**
 * Redis-Based Token Store
 * Stores provisioning tokens with TTL support in Redis (cloud)
 * Provides persistent storage for device provisioning tokens
 * Uses official 'redis' package (node-redis)
 */

import { RedisClientType } from 'redis';
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

  // In-memory fallback storage
  private inMemoryStore: Map<string, { entry: TokenEntry; expiresAt: number }> = new Map();
  private inMemoryDeviceMap: Map<string, string> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private useInMemory: boolean = false;

  constructor() {
    // Check if Redis is available
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

  /**
   * Initialize Redis connection
   */
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

  /**
   * Start in-memory cleanup task
   */
  private startInMemoryCleanup(): void {
    // Clean up expired tokens every minute
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, value] of this.inMemoryStore.entries()) {
        if (now > value.expiresAt) {
          this.inMemoryStore.delete(key);
          // Also remove from device map
          const deviceId = value.entry.deviceId;
          if (this.inMemoryDeviceMap.get(deviceId) === value.entry.token) {
            this.inMemoryDeviceMap.delete(deviceId);
          }
        }
      }
    }, 60000); // Every minute
  }

  /**
   * Store a token with TTL
   */
  async setToken(token: string, deviceId: string, ttlSeconds: number): Promise<void> {
    try {
      const expiresAt = Date.now() + (ttlSeconds * 1000);
      const entry: TokenEntry = {
        deviceId,
        token,
        expiresAt
      };

      const redis = this.getRedis();
      
      if (redis) {
        // Use Redis
      await redis.setEx(
        `${this.TOKEN_PREFIX}${token}`,
        ttlSeconds,
        JSON.stringify(entry)
      );
      await redis.setEx(
        `${this.DEVICE_PREFIX}${deviceId}`,
        ttlSeconds,
        token
      );
      logger.debug('Token stored in Redis', {
        deviceId,
        ttlSeconds,
        expiresAt: new Date(expiresAt).toISOString()
      });
      } else {
        // Use in-memory storage
        this.inMemoryStore.set(`${this.TOKEN_PREFIX}${token}`, { entry, expiresAt });
        this.inMemoryDeviceMap.set(deviceId, token);
        logger.debug('Token stored in memory', {
          deviceId,
          ttlSeconds,
          expiresAt: new Date(expiresAt).toISOString()
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to store token', { error: errorMessage });
      throw error;
    }
  }

  /**
   * Get device ID by token
   */
  async getDeviceByToken(token: string): Promise<string | null> {
    try {
      const redis = this.getRedis();
      
      if (redis) {
        // Use Redis
      const data = await redis.get(`${this.TOKEN_PREFIX}${token}`);
      if (!data) {
        return null;
      }
      const entry: TokenEntry = JSON.parse(data);
      if (Date.now() > entry.expiresAt) {
        await this.deleteToken(token);
        return null;
      }
      return entry.deviceId;
      } else {
        // Use in-memory storage
        const key = `${this.TOKEN_PREFIX}${token}`;
        const stored = this.inMemoryStore.get(key);
        if (!stored) {
          return null;
        }
        if (Date.now() > stored.expiresAt) {
          this.inMemoryStore.delete(key);
          this.inMemoryDeviceMap.delete(stored.entry.deviceId);
          return null;
        }
        return stored.entry.deviceId;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to get device by token', { error: errorMessage });
      return null;
    }
  }

  /**
   * Get token by device ID
   */
  async getTokenByDevice(deviceId: string): Promise<string | null> {
    try {
      const redis = this.getRedis();
      
      if (redis) {
        // Use Redis
      const token = await redis.get(`${this.DEVICE_PREFIX}${deviceId}`);
      if (!token) {
        return null;
      }
      const entry = await redis.get(`${this.TOKEN_PREFIX}${token}`);
      if (!entry) {
        await this.deleteTokenByDevice(deviceId);
        return null;
      }
        return token;
      } else {
        // Use in-memory storage
        const token = this.inMemoryDeviceMap.get(deviceId);
        if (!token) {
          return null;
        }
        const key = `${this.TOKEN_PREFIX}${token}`;
        const stored = this.inMemoryStore.get(key);
        if (!stored) {
          this.inMemoryDeviceMap.delete(deviceId);
          return null;
        }
      return token;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to get token by device', { error: errorMessage });
      return null;
    }
  }

  /**
   * Delete token
   */
  async deleteToken(token: string): Promise<void> {
    try {
      const redis = this.getRedis();
      const key = `${this.TOKEN_PREFIX}${token}`;

      if (redis) {
        // Use Redis
        const data = await redis.get(key);
      if (data) {
        const entry: TokenEntry = JSON.parse(data);
          await redis.del(key);
        await redis.del(`${this.DEVICE_PREFIX}${entry.deviceId}`);
        logger.debug('Token deleted from Redis', { token: token.substring(0, 20) + '...' });
        }
      } else {
        // Use in-memory storage
        const stored = this.inMemoryStore.get(key);
        if (stored) {
          this.inMemoryStore.delete(key);
          this.inMemoryDeviceMap.delete(stored.entry.deviceId);
          logger.debug('Token deleted from memory', { token: token.substring(0, 20) + '...' });
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to delete token', { error: errorMessage });
      throw error;
    }
  }

  /**
   * Delete token by device ID
   */
  async deleteTokenByDevice(deviceId: string): Promise<void> {
    try {
      const redis = this.getRedis();

      if (redis) {
        // Use Redis
      const token = await redis.get(`${this.DEVICE_PREFIX}${deviceId}`);
      if (token) {
        await redis.del(`${this.TOKEN_PREFIX}${token}`);
        await redis.del(`${this.DEVICE_PREFIX}${deviceId}`);
        logger.debug('Token deleted by device from Redis', { deviceId });
        }
      } else {
        // Use in-memory storage
        const token = this.inMemoryDeviceMap.get(deviceId);
        if (token) {
          this.inMemoryStore.delete(`${this.TOKEN_PREFIX}${token}`);
          this.inMemoryDeviceMap.delete(deviceId);
          logger.debug('Token deleted by device from memory', { deviceId });
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to delete token by device', { error: errorMessage });
      throw error;
    }
  }

  /**
   * Check if device has active token
   */
  async hasActiveToken(deviceId: string): Promise<boolean> {
    try {
      const token = await this.getTokenByDevice(deviceId);
      return token !== null;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get token entry (for debugging)
   */
  async getTokenEntry(token: string): Promise<TokenEntry | null> {
    try {
      const redis = this.getRedis();
      const key = `${this.TOKEN_PREFIX}${token}`;

      if (redis) {
        // Use Redis
        const data = await redis.get(key);
      if (!data) {
        return null;
      }
      return JSON.parse(data);
      } else {
        // Use in-memory storage
        const stored = this.inMemoryStore.get(key);
        if (!stored) {
          return null;
        }
        return stored.entry;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to get token entry', { error: errorMessage });
      return null;
    }
  }

  /**
   * Cleanup expired tokens (Redis handles this automatically with TTL)
   * This method is kept for interface compatibility
   */
  async cleanup(): Promise<void> {
    // Redis automatically removes expired keys, so this is a no-op
    // But we can log statistics
    try {
      const stats = await this.getStats();
      logger.debug('TokenStore status', stats);
    } catch (error) {
      logger.error('Failed to get TokenStore stats', { error });
    }
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<{
    tokenCount: number;
    deviceCount: number;
    connected: boolean;
    storage: 'redis' | 'memory';
  }> {
    try {
      const redis = this.getRedis();

      if (redis) {
        // Use Redis
      const tokenKeys = await redis.keys(`${this.TOKEN_PREFIX}*`);
      const deviceKeys = await redis.keys(`${this.DEVICE_PREFIX}*`);
      return {
        tokenCount: tokenKeys.length,
        deviceCount: deviceKeys.length,
          connected: true,
          storage: 'redis'
        };
      } else {
        // Use in-memory storage
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

  /**
   * Shutdown (cleanup)
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.inMemoryStore.clear();
    this.inMemoryDeviceMap.clear();
    logger.info('TokenStore shutdown');
    this.redis = null;
  }
}

// Singleton instance
let tokenStore: TokenStore | null = null;

export function getTokenStore(): TokenStore {
  if (!tokenStore) {
    tokenStore = new TokenStore();
  }
  return tokenStore;
}
