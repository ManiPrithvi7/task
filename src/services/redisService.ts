/**
 * Redis Service - Cloud Redis connection management
 * Provides persistent storage for provisioning tokens
 * Uses official 'redis' package (node-redis)
 */

import { createClient, RedisClientType } from 'redis';
import { logger } from '../utils/logger';

const REDIS_LOG_PREFIX = '[Redis]';

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
  private lastLoggedConnected: boolean | null = null;
  private commandCount: number = 0;
  private commandCountByType: Map<string, number> = new Map();

  constructor(config: RedisConfig) {
    this.config = config;
    logger.debug(`${REDIS_LOG_PREFIX} constructor`, {
      configured: !!(config.url && config.url.trim().length > 0),
      db: config.db ?? 0,
      keyPrefix: config.keyPrefix || 'proof-mqtt:'
    });
  }

  private logCall(
    fn: string,
    phase: 'enter' | 'exit' | 'skip' | 'result',
    meta?: Record<string, unknown>
  ): void {
    logger.debug(`${REDIS_LOG_PREFIX} ${fn} ${phase}`, meta);
  }

  private async traceAsync<T>(
    fn: string,
    meta: Record<string, unknown> | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    const start = performance.now();
    this.logCall(fn, 'enter', meta);
    try {
      const result = await operation();
      this.logCall(fn, 'exit', {
        ...meta,
        durationMs: Math.round(performance.now() - start)
      });
      return result;
    } catch (error) {
      this.logCall(fn, 'exit', {
        ...meta,
        durationMs: Math.round(performance.now() - start),
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
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
    const configured = !!(this.config.url && this.config.url.trim().length > 0);
    this.logCall('isRedisConfigured', 'exit', { configured });
    return configured;
  }

  /**
   * Connect to Redis using REDIS_URL (Upstash).
   */
  async connect(): Promise<void> {
    return this.traceAsync('connect', { alreadyConnected: this.isConnected }, async () => {
    try {
      if (this.isConnected && this.client) {
        this.logCall('connect', 'skip', { reason: 'already_connected' });
        logger.info('Redis already connected');
        return;
      }

      if (!this.isRedisConfigured()) {
        this.logCall('connect', 'skip', { reason: 'not_configured' });
        logger.warn('Redis is enabled but REDIS_URL is not set. Skipping connection.');
        this.isConnected = false;
        return;
      }

      const reconnectStrategy = (retries: number) => {
        if (retries > 20) {
          logger.error('Redis reconnect attempts exhausted', { retries });
          return new Error('Redis reconnect attempts exhausted');
        }
        const delayMs = Math.min(1000 * Math.pow(2, retries), 15000) + Math.floor(Math.random() * 250);
        logger.debug(`${REDIS_LOG_PREFIX} reconnectStrategy`, { retries, delayMs });
        return delayMs;
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

      // Wrap sendCommand to track request counts
      const originalSendCommand = this.client.sendCommand.bind(this.client);
      this.client.sendCommand = ((args, options) => {
        this.commandCount++;
        if (args.length > 0) {
          const cmd = String(args[0]).toUpperCase();
          this.commandCountByType.set(cmd, (this.commandCountByType.get(cmd) || 0) + 1);
        }
        return originalSendCommand(args, options);
      }) as typeof this.client.sendCommand;

      // Connect to Redis
      await this.client.connect();
      this.isConnected = true;

      logger.info('✅ Redis connected successfully', {
        keyPrefix: this.config.keyPrefix || 'proof-mqtt:'
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
    });
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    return this.traceAsync('disconnect', { hasClient: !!this.client }, async () => {
    try {
      if (!this.client) {
        this.logCall('disconnect', 'skip', { reason: 'no_client' });
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
    });
  }

  /**
   * Get Redis client
   */
  getClient(): RedisClientType {
    if (!this.client) {
      logger.error(`${REDIS_LOG_PREFIX} getClient failed`, { reason: 'not_initialized' });
      throw new Error('Redis client not initialized. Call connect() first.');
    }
    return this.client;
  }

  /**
   * Check if Redis is connected
   */
  isRedisConnected(): boolean {
    const connected = this.isConnected && this.client?.isOpen === true;
    if (connected !== this.lastLoggedConnected) {
      this.logCall('isRedisConnected', 'result', {
        connected,
        isConnectedFlag: this.isConnected,
        clientOpen: this.client?.isOpen ?? false
      });
      this.lastLoggedConnected = connected;
    }
    return connected;
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    return this.traceAsync('healthCheck', undefined, async () => {
    try {
      if (!this.client || !this.isConnected) {
        this.logCall('healthCheck', 'skip', { reason: 'not_connected' });
        return false;
      }

      const pong = await this.client.ping();
      const healthy = pong === 'PONG';
      this.logCall('healthCheck', 'result', { healthy, pong });
      return healthy;
    } catch (error) {
      logger.error('Redis health check failed', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return false;
    }
    });
  }

  /**
   * Get Redis command statistics
   */
  getCommandStats(): { total: number; byType: Record<string, number> } {
    const byType: Record<string, number> = {};
    for (const [cmd, count] of this.commandCountByType) {
      byType[cmd] = count;
    }
    return { total: this.commandCount, byType };
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    if (!this.client) {
      this.logCall('setupEventHandlers', 'skip', { reason: 'no_client' });
      return;
    }

    this.logCall('setupEventHandlers', 'enter');

    this.client.on('connect', () => {
      logger.info(`${REDIS_LOG_PREFIX} event:connect`);
    });

    this.client.on('ready', () => {
      logger.info(`${REDIS_LOG_PREFIX} event:ready`);
      this.isConnected = true;
      this.lastLoggedConnected = null;
    });

    this.client.on('end', () => {
      logger.warn(`${REDIS_LOG_PREFIX} event:end`);
      this.isConnected = false;
      this.lastLoggedConnected = null;
    });

    this.client.on('reconnecting', () => {
      logger.info(`${REDIS_LOG_PREFIX} event:reconnecting`);
    });

    this.logCall('setupEventHandlers', 'exit');
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<{
    connected: boolean;
    keyCount: number;
    memory: string;
    commands: { total: number; byType: Record<string, number> };
  }> {
    return this.traceAsync('getStats', { keyPrefix: this.config.keyPrefix || 'proof-mqtt:' }, async () => {
    try {
      if (!this.isRedisConnected() || !this.client) {
        this.logCall('getStats', 'skip', { reason: 'not_connected' });
        return {
          connected: false,
          keyCount: 0,
          memory: 'N/A',
          commands: this.getCommandStats()
        };
      }

      const keyPattern = `${this.config.keyPrefix || 'proof-mqtt:'}*`;
      const keysStart = performance.now();
      const keys: string[] = [];
      let cursor = 0;
      do {
        const result = await this.client.scan(cursor, { MATCH: keyPattern, COUNT: 1000 });
        cursor = result.cursor;
        keys.push(...result.keys);
      } while (cursor !== 0);
      const keysDurationMs = Math.round(performance.now() - keysStart);

      const infoStart = performance.now();
      const info = await this.client.info('memory');
      const infoDurationMs = Math.round(performance.now() - infoStart);

      if (keysDurationMs > 100 || keys.length > 1000) {
        logger.warn(`${REDIS_LOG_PREFIX} getStats: SCAN slow or large result set`, {
          keyPattern,
          keyCount: keys.length,
          keysDurationMs
        });
      }

      const memoryMatch = info.match(/used_memory_human:([^\r\n]+)/);
      const memory = memoryMatch ? memoryMatch[1] : 'Unknown';

      this.logCall('getStats', 'result', {
        keyCount: keys.length,
        memory,
        keysDurationMs,
        infoDurationMs
      });

      return {
        connected: true,
        keyCount: keys.length,
        memory,
        commands: this.getCommandStats()
      };
    } catch (error) {
      logger.error('Failed to get Redis stats', { error });
      return {
        connected: this.isConnected,
        keyCount: 0,
        memory: 'Error',
        commands: this.getCommandStats()
      };
    }
    });
  }
}

// Singleton instance
let redisService: RedisService | null = null;

export function getRedisService(): RedisService | null {
  return redisService;
}

export function createRedisService(config: RedisConfig): RedisService {
  logger.debug(`${REDIS_LOG_PREFIX} createRedisService`, {
    hasUrl: !!(config.url && config.url.trim()),
    db: config.db ?? 0,
    keyPrefix: config.keyPrefix || 'proof-mqtt:'
  });
  redisService = new RedisService(config);
  return redisService;
}
