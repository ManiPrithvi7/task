/**
 * Redis Service - Cloud Redis connection management
 * Provides persistent storage for provisioning tokens
 * Uses official 'redis' package (node-redis)
 */

import { createClient, RedisClientType } from 'redis';
import { logger } from '../utils/logger';

export interface RedisConfig {
  /** Preferred: single URL (Upstash). Example: rediss://default:...@host:6379 */
  url?: string;
  db?: number;
  keyPrefix?: string;
}

export class RedisService {
  private client: RedisClientType | null = null;
  private config: RedisConfig;
  private isConnected: boolean = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(config: RedisConfig) {
    this.config = config;
  }

  private safeTargetForLogs(): { mode: 'url' | 'none'; host?: string; port?: number; tls?: boolean } {
    const url = this.config.url?.trim();
    if (url) {
      try {
        const u = new URL(url);
        return {
          mode: 'url',
          host: u.hostname,
          port: u.port ? parseInt(u.port, 10) : undefined,
          tls: u.protocol === 'rediss:'
        };
      } catch {
        return { mode: 'url' };
      }
    }
    return { mode: 'none' };
  }

  /**
   * Check if Redis is configured (REDIS_URL).
   */
  isRedisConfigured(): boolean {
    return !!(this.config.url && this.config.url.trim().length > 0);
  }

  /**
   * Connect to Redis using REDIS_URL (Upstash).
   */
  async connect(): Promise<void> {
    try {
      if (this.isConnected && this.client) {
        logger.info('Redis already connected');
        return;
      }

      if (!this.isRedisConfigured()) {
        logger.warn('Redis is enabled but REDIS_URL is not set. Skipping connection.');
        this.isConnected = false;
        return;
      }

      const reconnectStrategy = (retries: number) => {
        if (retries > 20) {
          logger.error('Redis reconnect attempts exhausted', { retries });
          return new Error('Redis reconnect attempts exhausted');
        }
        const base = Math.min(1000 * Math.pow(2, retries), 15000);
        const jitter = Math.floor(Math.random() * 250);
        return base + jitter;
      };

      const target = this.safeTargetForLogs();
      logger.info('Connecting to Redis', {
        mode: target.mode,
        host: target.host,
        port: target.port,
        db: this.config.db ?? 0,
        tls: target.tls
      });

      const socketBase = {
        connectTimeout: 10000,
        keepAlive: 5000,
        noDelay: true,
        reconnectStrategy
      };

      const url = this.config.url?.trim();
      // URL contains auth and host. Use rediss:// for TLS (Upstash).
      this.client = createClient({
        url,
        socket: {
          ...socketBase,
          ...(url && url.startsWith('rediss://') ? { tls: true } : {})
        },
        database: this.config.db ?? 0
      }) as RedisClientType;

      // Setup error handler
      this.client.on('error', (err: Error) => {
        logger.error('Redis Client Error', { error: err.message });
        this.isConnected = false;
      });

      // Setup event handlers
      this.setupEventHandlers();

      // Connect to Redis
      await this.client.connect();
      this.isConnected = true;
      this.startHeartbeat();

      logger.info('✅ Redis connected successfully', {
        keyPrefix: this.config.keyPrefix || 'mqtt-lite:'
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const isENOTFOUND = errorMessage.includes('ENOTFOUND') || (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOTFOUND');
      logger.error('❌ Failed to connect to Redis', {
        error: errorMessage,
        config: this.safeTargetForLogs()
      });
      if (isENOTFOUND) {
        logger.warn('Redis host could not be resolved (DNS). Check REDIS_URL and network reachability. To run without Redis, unset REDIS_URL.');
      }
      throw new Error(`Redis connection failed: ${errorMessage}`);
    }
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    try {
      if (!this.client) {
        logger.debug('Redis already disconnected');
        return;
      }

      // Check if client is open before trying to quit
      if (this.client.isOpen) {
        await this.client.quit();
      } else {
        logger.debug('Redis client already closed, skipping quit');
      }

      this.stopHeartbeat();
      this.client = null;
      this.isConnected = false;

      logger.info('Redis disconnected successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      // Don't throw on disconnect errors - client might already be closed
      logger.debug('Redis disconnect completed (client may have been closed)', { error: errorMessage });
      this.stopHeartbeat();
      this.client = null;
      this.isConnected = false;
    }
  }

  /**
   * Get Redis client
   */
  getClient(): RedisClientType {
    if (!this.client) {
      throw new Error('Redis client not initialized. Call connect() first.');
    }
    return this.client;
  }

  /**
   * Check if Redis is connected
   */
  isRedisConnected(): boolean {
    return this.isConnected && this.client?.isOpen === true;
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      if (!this.client || !this.isConnected) {
        return false;
      }

      const pong = await this.client.ping();
      return pong === 'PONG';
    } catch (error) {
      logger.error('Redis health check failed', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return false;
    }
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    if (!this.client) return;

    this.client.on('connect', () => {
      logger.info('Redis connection established');
    });

    this.client.on('ready', () => {
      logger.info('Redis ready to accept commands');
      this.isConnected = true;
      this.startHeartbeat();
    });

    this.client.on('end', () => {
      logger.warn('Redis connection ended');
      this.isConnected = false;
      this.stopHeartbeat();
    });

    this.client.on('reconnecting', () => {
      logger.info('Redis reconnecting...');
    });

  }

  /**
   * Get statistics
   */
  async getStats(): Promise<{
    connected: boolean;
    keyCount: number;
    memory: string;
  }> {
    try {
      if (!this.isRedisConnected() || !this.client) {
        return {
          connected: false,
          keyCount: 0,
          memory: 'N/A'
        };
      }

      const keyPattern = `${this.config.keyPrefix || 'mqtt-lite:'}*`;
      const keys = await this.client.keys(keyPattern);
      const info = await this.client.info('memory');
      
      const memoryMatch = info.match(/used_memory_human:([^\r\n]+)/);
      const memory = memoryMatch ? memoryMatch[1] : 'Unknown';

      return {
        connected: true,
        keyCount: keys.length,
        memory
      };
    } catch (error) {
      logger.error('Failed to get Redis stats', { error });
      return {
        connected: this.isConnected,
        keyCount: 0,
        memory: 'Error'
      };
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(async () => {
      try {
        if (!this.client || !this.isConnected || !this.client.isOpen) return;
        await this.client.ping();
      } catch (err) {
        logger.warn('Redis heartbeat ping failed', {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}

// Singleton instance
let redisService: RedisService | null = null;

export function getRedisService(): RedisService | null {
  return redisService;
}

export function createRedisService(config: RedisConfig): RedisService {
  redisService = new RedisService(config);
  return redisService;
}
