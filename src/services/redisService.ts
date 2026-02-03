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
  // Supports both redis:// and rediss:// (TLS) URLs
  // Example: rediss://username:password@host:port
  keyPrefix?: string;
  tls?: boolean; // Enable TLS for non-URL connections (when using host/port)
}

export class RedisService {
  private client: RedisClientType | null = null;
  private config: RedisConfig;
  private isConnected: boolean = false;

  constructor(config: RedisConfig) {
    this.config = config;
  }

  /**
   * Check if Redis is configured (has connection details)
   */
  isRedisConfigured(): boolean {
    return !!this.config.url || (!!this.config.host && !!this.config.port);
  }

  /**
   * Returns a valid Redis URL (trimmed, parseable) or undefined if URL is missing/invalid.
   * Invalid URLs often come from copy-paste (newlines, or password with unencoded special chars).
   */
  private getValidRedisUrl(): string | undefined {
    const raw = this.config.url?.trim();
    if (!raw) return undefined;
    try {
      new URL(raw);
      return raw;
    } catch {
      return undefined;
    }
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

      // Check if Redis is configured before attempting connection
      if (!this.isRedisConfigured()) {
        logger.warn('Redis is enabled but no connection details provided. Skipping connection.');
        this.isConnected = false;
        return;
      }

      const useUrl = this.getValidRedisUrl();
      const useHostPort = this.config.host && this.config.port !== undefined && this.config.port !== null;

      if (useUrl) {
        // Use URL-based connection (supports both redis:// and rediss://)
        // rediss:// automatically enables TLS/SSL (Redis Cloud compatible)
        const isTLS = useUrl.startsWith('rediss://');
        logger.info('Connecting to Redis using URL', {
          url: this.sanitizeUrl(useUrl),
          tls: isTLS
        });

        this.client = createClient({
          url: useUrl,
          socket: {
            reconnectStrategy: false,
            connectTimeout: 10000, // 10s fail-fast; ENOTFOUND/ETIMEDOUT surface quickly
            tls: isTLS ? undefined : false
          }
        }) as RedisClientType;
      } else if (useHostPort) {
        // Fallback: host/port (when REDIS_URL is invalid or not set - e.g. password with special chars, or copy-paste newline)
        logger.info('Connecting to Redis using host/port', {
          host: this.config.host,
          port: this.config.port,
          username: this.config.username || 'default',
          db: this.config.db ?? 0,
          tls: this.config.tls ?? false
        });

        this.client = createClient({
          username: this.config.username || 'default',
          password: this.config.password,
          socket: {
            host: this.config.host!,
            port: this.config.port!,
            reconnectStrategy: false,
            connectTimeout: 10000,
            tls: this.config.tls ? undefined : false
          },
          database: this.config.db ?? 0
        }) as RedisClientType;
      } else {
        throw new Error(
          'Invalid Redis URL and no host/port. Fix REDIS_URL (trim newlines/spaces; encode special chars in password) or set REDIS_HOST and REDIS_PORT.'
        );
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
      const isENOTFOUND = errorMessage.includes('ENOTFOUND') || (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOTFOUND');
      logger.error('❌ Failed to connect to Redis', {
        error: errorMessage,
        config: {
          url: this.config.url ? this.sanitizeUrl(this.config.url) : undefined,
          host: this.config.host,
          port: this.config.port,
          username: this.config.username
        }
      });
      if (isENOTFOUND) {
        logger.warn('Redis host could not be resolved (DNS). Check REDIS_HOST/REDIS_URL is correct, your network has internet access, and the Redis Cloud database is active. To run without Redis set REDIS_ENABLED=false.');
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
