/**
 * Redis Service - Cloud Redis connection management
 * Provides persistent storage for provisioning tokens
 * Uses official 'redis' package (node-redis)
 */

import { createClient, RedisClientType } from 'redis';
import { logger } from '../utils/logger';

export interface RedisConfig {
  username?: string;
  password?: string;
  host?: string;
  port?: number;
  db?: number;
  url?: string; // Full Redis URL (alternative to username/password/host/port)
  keyPrefix?: string;
}

export class RedisService {
  private client: RedisClientType | null = null;
  private config: RedisConfig;
  private isConnected: boolean = false;

  constructor(config: RedisConfig) {
    this.config = config;
  }

  /**
   * Connect to Redis
   */
  async connect(): Promise<void> {
    try {
      if (this.isConnected && this.client) {
        logger.info('Redis already connected');
        return;
      }

      // Create Redis client based on configuration
      if (this.config.url) {
        // Use URL-based connection
        logger.info('Connecting to Redis using URL', {
          url: this.sanitizeUrl(this.config.url)
        });

        this.client = createClient({
          url: this.config.url,
          socket: {
            reconnectStrategy: false // Disable automatic reconnection
          }
        }) as RedisClientType;
      } else {
        // Use individual parameters (matching your example)
        // Check if Redis is actually configured
        if (!this.config.host && !this.config.port) {
          throw new Error('Redis host and port are required when not using URL');
        }

        logger.info('Connecting to Redis', {
          host: this.config.host,
          port: this.config.port,
          username: this.config.username || 'default',
          db: this.config.db || 0
        });

        this.client = createClient({
          username: this.config.username || 'default',
          password: this.config.password,
          socket: {
            host: this.config.host!,
            port: this.config.port!,
            reconnectStrategy: false // Disable automatic reconnection
          },
          database: this.config.db || 0
        }) as RedisClientType;
      }

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
      logger.error('❌ Failed to connect to Redis', {
        error: errorMessage,
        config: {
          url: this.config.url ? this.sanitizeUrl(this.config.url) : undefined,
          host: this.config.host,
          port: this.config.port,
          username: this.config.username
        }
      });
      throw new Error(`Redis connection failed: ${errorMessage}`);
    }
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    try {
      if (!this.client) {
        logger.info('Redis already disconnected');
        return;
      }

      await this.client.quit();
      this.client = null;
      this.isConnected = false;

      logger.info('Redis disconnected successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to disconnect from Redis', { error: errorMessage });
      throw error;
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
   * Sanitize URL for logging (remove credentials)
   */
  private sanitizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      if (parsed.password) {
        return url.replace(`:${parsed.password}@`, ':***@');
      }
      return url;
    } catch {
      return '[invalid URL]';
    }
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
