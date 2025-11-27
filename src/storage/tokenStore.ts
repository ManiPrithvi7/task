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

  constructor() {
    // Redis client will be initialized when app starts
    logger.info('TokenStore initialized (Redis-based)');
  }

  /**
   * Initialize Redis connection
   */
  private getRedis(): RedisClientType {
    if (!this.redis) {
      const redisService = getRedisService();
      if (!redisService || !redisService.isRedisConnected()) {
        throw new Error('Redis not connected. Ensure Redis service is initialized.');
      }
      this.redis = redisService.getClient();
    }
    return this.redis;
  }

  /**
   * Store a token with TTL
   */
  async setToken(token: string, deviceId: string, ttlSeconds: number): Promise<void> {
    try {
      const redis = this.getRedis();
      const expiresAt = Date.now() + (ttlSeconds * 1000);

      const entry: TokenEntry = {
        deviceId,
        token,
        expiresAt
      };

      // Store token -> device mapping with TTL (using setEx)
      await redis.setEx(
        `${this.TOKEN_PREFIX}${token}`,
        ttlSeconds,
        JSON.stringify(entry)
      );

      // Store device -> token mapping with TTL (using setEx)
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
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to store token in Redis', { error: errorMessage });
      throw error;
    }
  }

  /**
   * Get device ID by token
   */
  async getDeviceByToken(token: string): Promise<string | null> {
    try {
      const redis = this.getRedis();
      const data = await redis.get(`${this.TOKEN_PREFIX}${token}`);

      if (!data) {
        return null;
      }

      const entry: TokenEntry = JSON.parse(data);

      // Check if expired (Redis TTL should handle this, but double-check)
      if (Date.now() > entry.expiresAt) {
        await this.deleteToken(token);
        return null;
      }

      return entry.deviceId;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to get device by token from Redis', { error: errorMessage });
      return null;
    }
  }

  /**
   * Get token by device ID
   */
  async getTokenByDevice(deviceId: string): Promise<string | null> {
    try {
      const redis = this.getRedis();
      const token = await redis.get(`${this.DEVICE_PREFIX}${deviceId}`);

      if (!token) {
        return null;
      }

      // Verify token still exists and is valid
      const entry = await redis.get(`${this.TOKEN_PREFIX}${token}`);
      if (!entry) {
        // Token expired, clean up device mapping
        await this.deleteTokenByDevice(deviceId);
        return null;
      }

      return token;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to get token by device from Redis', { error: errorMessage });
      return null;
    }
  }

  /**
   * Delete token
   */
  async deleteToken(token: string): Promise<void> {
    try {
      const redis = this.getRedis();

      // Get device ID first
      const data = await redis.get(`${this.TOKEN_PREFIX}${token}`);
      if (data) {
        const entry: TokenEntry = JSON.parse(data);

        // Delete both mappings
        await redis.del(`${this.TOKEN_PREFIX}${token}`);
        await redis.del(`${this.DEVICE_PREFIX}${entry.deviceId}`);

        logger.debug('Token deleted from Redis', { token: token.substring(0, 20) + '...' });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to delete token from Redis', { error: errorMessage });
      throw error;
    }
  }

  /**
   * Delete token by device ID
   */
  async deleteTokenByDevice(deviceId: string): Promise<void> {
    try {
      const redis = this.getRedis();

      // Get token first
      const token = await redis.get(`${this.DEVICE_PREFIX}${deviceId}`);
      if (token) {
        // Delete both mappings
        await redis.del(`${this.TOKEN_PREFIX}${token}`);
        await redis.del(`${this.DEVICE_PREFIX}${deviceId}`);

        logger.debug('Token deleted by device from Redis', { deviceId });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to delete token by device from Redis', { error: errorMessage });
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
      const data = await redis.get(`${this.TOKEN_PREFIX}${token}`);

      if (!data) {
        return null;
      }

      return JSON.parse(data);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to get token entry from Redis', { error: errorMessage });
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
  }> {
    try {
      const redis = this.getRedis();

      // Count tokens and devices using KEYS
      const tokenKeys = await redis.keys(`${this.TOKEN_PREFIX}*`);
      const deviceKeys = await redis.keys(`${this.DEVICE_PREFIX}*`);

      return {
        tokenCount: tokenKeys.length,
        deviceCount: deviceKeys.length,
        connected: true
      };
    } catch (error) {
      logger.error('Failed to get stats', { error });
      return {
        tokenCount: 0,
        deviceCount: 0,
        connected: false
      };
    }
  }

  /**
   * Shutdown (cleanup)
   */
  shutdown(): void {
    logger.info('TokenStore shutdown (Redis connection managed by RedisService)');
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
