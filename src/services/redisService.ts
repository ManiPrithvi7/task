/**
 * Redis Service - Cloud Redis connection management
 * Provides persistent storage for provisioning tokens
 * Uses official 'redis' package (node-redis)
 */

import { createClient, RedisClientType } from 'redis';
import { logger } from '../utils/logger';

export interface RedisConfig {
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
  tls?: boolean; // Enable TLS for Redis Cloud (REDIS_TLS=true)
}

export class RedisService {
  private client: RedisClientType | null = null;
  private config: RedisConfig;
  private isConnected: boolean = false;

  constructor(config: RedisConfig) {
    this.config = config;
  }

  /**
   * Check if Redis is configured (host + port required).
   */
  isRedisConfigured(): boolean {
    return !!(this.config.host && this.config.port !== undefined && this.config.port !== null);
  }

  /**
   * Connect to Redis using host, port, password (same format as node-redis / Redis Cloud).
   */
  async connect(): Promise<void> {
    try {
      if (this.isConnected && this.client) {
        logger.info('Redis already connected');
        return;
      }

      if (!this.isRedisConfigured()) {
        logger.warn('Redis is enabled but no connection details provided. Skipping connection.');
        this.isConnected = false;
        return;
      }

      logger.info('Connecting to Redis', {
        host: this.config.host,
        port: this.config.port,
        db: this.config.db ?? 0,
        tls: this.config.tls ?? false
      });

      this.client = createClient({
        username: 'default', // Redis 6+ ACL / Redis Cloud
        password: this.config.password,
        socket: {
          host: this.config.host!,
          port: this.config.port!,
          ...(this.config.tls && { tls: true })
        },
        database: this.config.db ?? 0
      }) as RedisClientType;

      // Setup error handler
      this.client.on('error', (err: Error) => {
        logger.error('Redis Client Error', { error: err.message });
        this.isConnected = false;
        // Don't attempt to reconnect - fail gracefully
      });

      // Setup event handlers
      this.setupEventHandlers();

      // Connect to Redis
      await this.client.connect();
      this.isConnected = true;

      logger.info('✅ Redis connected successfully', {
        keyPrefix: this.config.keyPrefix || 'mqtt-lite:'
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const isENOTFOUND = errorMessage.includes('ENOTFOUND') || (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOTFOUND');
      logger.error('❌ Failed to connect to Redis', {
        error: errorMessage,
        config: { host: this.config.host, port: this.config.port }
      });
      if (isENOTFOUND) {
        logger.warn('Redis host could not be resolved (DNS). Check REDIS_HOST and REDIS_PORT, and that Redis is reachable. To run without Redis set REDIS_ENABLED=false.');
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
      
      this.client = null;
      this.isConnected = false;

      logger.info('Redis disconnected successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      // Don't throw on disconnect errors - client might already be closed
      logger.debug('Redis disconnect completed (client may have been closed)', { error: errorMessage });
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
    });

    this.client.on('end', () => {
      logger.warn('Redis connection ended');
      this.isConnected = false;
    });

    this.client.on('reconnecting', () => {
      logger.info('Redis reconnecting...');
    });

    // Disable automatic reconnection on connection failure
    this.client.on('error', () => {
      // Error handler already set above, but ensure we don't reconnect
      if (this.client) {
        this.client.removeAllListeners('reconnecting');
      }
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
