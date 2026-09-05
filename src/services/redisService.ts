/**
 * Redis Service - Cloud Redis connection management
 * Provides persistent storage for provisioning tokens
 * Uses official 'redis' package (node-redis)
 */

import * as fs from 'fs';
import * as path from 'path';
import { createClient, RedisClientType } from 'redis';
import redisCommands from '@redis/client/dist/lib/client/commands.js';
import { logger } from '../utils/logger';

const REDIS_COMMAND_DEFINITIONS = redisCommands;

const REDIS_LOG_PREFIX = '[Redis]';
const REDIS_USAGE_CSV_NAME = 'redis_usage.csv';
const REDIS_USAGE_CSV_HEADER =
  'timestamp,operation,command,key,query_or_write,status,duration_ms,error\n';
const REDIS_USAGE_VALUE_MAX_LEN = 2000;

const REDIS_READ_COMMANDS = new Set([
  'GET', 'MGET', 'HGET', 'HGETALL', 'HMGET', 'HLEN', 'HEXISTS', 'HKEYS', 'HVALS', 'HSTRLEN',
  'LINDEX', 'LLEN', 'LPOS', 'LRANGE', 'LCS', 'SMEMBERS', 'SISMEMBER', 'SMISMEMBER', 'SCARD',
  'SRANDMEMBER', 'ZRANGE', 'ZRANGEBYSCORE', 'ZREVRANGE', 'ZREVRANGEBYSCORE', 'ZRANK', 'ZREVRANK',
  'ZSCORE', 'ZMSCORE', 'ZCARD', 'ZCOUNT', 'ZLEXCOUNT', 'EXISTS', 'TTL', 'PTTL', 'TYPE', 'STRLEN',
  'GETBIT', 'BITCOUNT', 'BITPOS', 'GEOPOS', 'GEODIST', 'GEOHASH', 'XREAD', 'XLEN', 'XRANGE',
  'XREVRANGE', 'XPENDING', 'SCAN', 'HSCAN', 'SSCAN', 'ZSCAN', 'PING', 'INFO', 'DBSIZE', 'KEYS',
  'XINFO', 'GEORADIUS', 'GEORADIUSBYMEMBER', 'GEOSEARCH', 'GEOSEARCHSTORE'
]);

const REDIS_WRITE_COMMANDS = new Set([
  'SET', 'SETEX', 'SETNX', 'SETXX', 'MSET', 'MSETNX', 'GETSET', 'GETDEL', 'GETEX', 'HSET', 'HSETNX',
  'HMSET', 'HDEL', 'HINCRBY', 'HINCRBYFLOAT', 'LPUSH', 'LPUSHX', 'RPUSH', 'RPUSHX', 'LPOP', 'RPOP',
  'LREM', 'LSET', 'LTRIM', 'BLMOVE', 'LMOVE', 'SADD', 'SREM', 'SPOP', 'SMOVE', 'SUNIONSTORE',
  'SINTERSTORE', 'SDIFFSTORE', 'ZADD', 'ZREM', 'ZINCRBY', 'ZPOPMIN', 'ZPOPMAX', 'BZPOPMIN', 'BZPOPMAX',
  'DEL', 'UNLINK', 'EXPIRE', 'EXPIREAT', 'PEXPIRE', 'PEXPIREAT', 'PERSIST', 'INCR', 'INCRBY',
  'INCRBYFLOAT', 'DECR', 'DECRBY', 'APPEND', 'SETBIT', 'BITOP', 'GEOADD', 'XADD', 'XDEL', 'XTRIM',
  'XCLAIM', 'XGROUP', 'XACK', 'EVAL', 'EVALSHA', 'SCRIPT', 'FLUSHDB', 'FLUSHALL', 'RENAME', 'RENAMENX',
  'COPY', 'MIGRATE', 'RESTORE', 'PUBLISH', 'SPUBLISH'
]);

export interface RedisConfig {
  /** Preferred: single URL (Upstash). Example: rediss://default:...@host:6379 */
  url?: string;
  db?: number;
  keyPrefix?: string;
  /** Directory for redis_usage.csv (default: DATA_DIR or ./data) */
  dataDir?: string;
}

export class RedisService {
  private client: RedisClientType | null = null;
  private config: RedisConfig;
  private isConnected: boolean = false;
  private lastLoggedConnected: boolean | null = null;
  private commandCount: number = 0;
  private commandCountByType: Map<string, number> = new Map();
  /** Process/service observation window start (for command stats). */
  private readonly startedAtIso: string = new Date().toISOString();
  private readonly usageCsvPath: string;
  private usageCsvReady = false;
  private usageLogQueue: string[] = [];
  private usageLogWriting = false;

  /** In-memory CSV flush backlog (grows if disk append fails). */
  usageLogQueueLength(): number {
    return this.usageLogQueue.length;
  }

  constructor(config: RedisConfig) {
    this.usageCsvPath = path.resolve(
      config.dataDir || process.env.DATA_DIR || './data',
      REDIS_USAGE_CSV_NAME
    );
    this.config = config;
    logger.debug(`${REDIS_LOG_PREFIX} constructor`, {
      configured: !!(config.url && config.url.trim().length > 0),
      db: config.db ?? 0,
      keyPrefix: config.keyPrefix || 'proof-mqtt:',
      since: this.startedAtIso
    });
  }

  private logCall(
    fn: string,
    phase: 'enter' | 'exit' | 'skip' | 'result',
    meta?: Record<string, unknown>
  ): void {
    logger.debug(`${REDIS_LOG_PREFIX} ${fn} ${phase}`, meta);
  }

  private classifyRedisOperation(command: string): 'read' | 'write' | 'other' {
    if (REDIS_READ_COMMANDS.has(command)) return 'read';
    if (REDIS_WRITE_COMMANDS.has(command)) return 'write';
    return 'other';
  }

  private truncateUsageValue(value: string): string {
    if (value.length <= REDIS_USAGE_VALUE_MAX_LEN) return value;
    return `${value.slice(0, REDIS_USAGE_VALUE_MAX_LEN)}…`;
  }

  private escapeCsvField(value: string): string {
    if (/[",\n\r]/.test(value)) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  private buildUsageQueryOrWrite(command: string, args: string[], operation: 'read' | 'write' | 'other'): string {
    if (args.length <= 1) return args.join(' ');

    if (operation === 'write') {
      return this.truncateUsageValue(args.slice(2).join(' ') || args.slice(1).join(' '));
    }

    if (operation === 'read') {
      return this.truncateUsageValue(args.slice(1).join(' '));
    }

    return this.truncateUsageValue(args.join(' '));
  }

  private ensureUsageCsvReady(): void {
    if (this.usageCsvReady) return;

    fs.mkdirSync(path.dirname(this.usageCsvPath), { recursive: true });
    if (!fs.existsSync(this.usageCsvPath)) {
      fs.writeFileSync(this.usageCsvPath, REDIS_USAGE_CSV_HEADER, { encoding: 'utf8' });
    }
    this.usageCsvReady = true;
  }

  private buildUsageCsvLine(entry: {
    timestamp: string;
    operation: 'read' | 'write' | 'other';
    command: string;
    key: string;
    queryOrWrite: string;
    status: 'ok' | 'error';
    durationMs: number;
    error: string;
  }): string {
    return [
      this.escapeCsvField(entry.timestamp),
      this.escapeCsvField(entry.operation),
      this.escapeCsvField(entry.command),
      this.escapeCsvField(entry.key),
      this.escapeCsvField(entry.queryOrWrite),
      this.escapeCsvField(entry.status),
      String(entry.durationMs),
      this.escapeCsvField(entry.error)
    ].join(',') + '\n';
  }

  /** Append one Redis command observation to data/redis_usage.csv. */
  private logRedisUsageToCsv(entry: {
    timestamp: string;
    operation: 'read' | 'write' | 'other';
    command: string;
    key: string;
    queryOrWrite: string;
    status: 'ok' | 'error';
    durationMs: number;
    error: string;
  }): void {
    this.usageLogQueue.push(this.buildUsageCsvLine(entry));
    void this.flushUsageLogQueue();
  }

  private async flushUsageLogQueue(): Promise<void> {
    if (this.usageLogWriting || this.usageLogQueue.length === 0) return;

    this.usageLogWriting = true;
    try {
      this.ensureUsageCsvReady();
      while (this.usageLogQueue.length > 0) {
        const batch = this.usageLogQueue.splice(0, 100).join('');
        await fs.promises.appendFile(this.usageCsvPath, batch, { encoding: 'utf8' });
      }
    } catch (error) {
      logger.warn(`${REDIS_LOG_PREFIX} failed to write redis usage CSV`, {
        path: this.usageCsvPath,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.usageLogWriting = false;
      if (this.usageLogQueue.length > 0) {
        void this.flushUsageLogQueue();
      }
    }
  }

  private recordSendCommandUsage(
    args: ReadonlyArray<string | Buffer>,
    startMs: number,
    status: 'ok' | 'error',
    errorMessage = ''
  ): void {
    const stringArgs = args.map(String);
    const command = stringArgs.length > 0 ? stringArgs[0].toUpperCase() : 'UNKNOWN';
    const operation = this.classifyRedisOperation(command);
    const key = stringArgs.length > 1 ? stringArgs[1] : '';

    this.logRedisUsageToCsv({
      timestamp: new Date().toISOString(),
      operation,
      command,
      key,
      queryOrWrite: this.buildUsageQueryOrWrite(command, stringArgs, operation),
      status,
      durationMs: Math.round(performance.now() - startMs),
      error: errorMessage
    });
  }

  private incrementCommandCount(args: ReadonlyArray<string | Buffer>): void {
    this.commandCount++;
    if (args.length > 0) {
      const cmd = String(args[0]).toUpperCase();
      this.commandCountByType.set(cmd, (this.commandCountByType.get(cmd) || 0) + 1);
    }
  }

  private attachUsageTrackingToResult(
    result: unknown,
    args: ReadonlyArray<string | Buffer>,
    startMs: number
  ): unknown {
    if (
      result !== null &&
      typeof result === 'object' &&
      'then' in result &&
      typeof (result as Promise<unknown>).then === 'function'
    ) {
      return (result as Promise<unknown>)
        .then((value) => {
          this.recordSendCommandUsage(args, startMs, 'ok');
          return value;
        })
        .catch((error: unknown) => {
          this.recordSendCommandUsage(
            args,
            startMs,
            'error',
            error instanceof Error ? error.message : String(error)
          );
          throw error;
        });
    }

    this.recordSendCommandUsage(args, startMs, 'ok');
    return result;
  }

  private extractRedisArgsFromCommand(
    command: unknown,
    args: unknown[]
  ): ReadonlyArray<string | Buffer> {
    const cmd = command as {
      transformArguments?: (...commandArgs: unknown[]) => Array<string | Buffer>;
    };
    if (typeof cmd?.transformArguments !== 'function') {
      return ['UNKNOWN'];
    }

    try {
      return cmd.transformArguments(...args);
    } catch {
      try {
        return cmd.transformArguments(...args.slice(1));
      } catch {
        return ['UNKNOWN'];
      }
    }
  }

  /**
   * node-redis v4 binds each command (get/set/hGetAll/…) to a closure over
   * commandsExecutor at class load time, so patching instance.commandsExecutor
   * does nothing. Wrap each command method on this client instead.
   */
  private trackRedisCommand(
    redisArgs: ReadonlyArray<string | Buffer>,
    run: () => Promise<unknown>
  ): Promise<unknown> {
    const startMs = performance.now();
    this.incrementCommandCount(redisArgs);
    return run()
      .then((result) => {
        this.recordSendCommandUsage(redisArgs, startMs, 'ok');
        return result;
      })
      .catch((error: unknown) => {
        this.recordSendCommandUsage(
          redisArgs,
          startMs,
          'error',
          error instanceof Error ? error.message : String(error)
        );
        throw error;
      });
  }

  private wrapClientForUsageTracking(client: RedisClientType): void {
    type MultiExecutor = (...multiArgs: unknown[]) => Promise<unknown>;

    const tracked = client as RedisClientType & Record<string, unknown> & {
      multiExecutor: MultiExecutor;
    };
    const wrappedMethods = Symbol('redisUsageWrapped');

    for (const [name, commandDef] of Object.entries(REDIS_COMMAND_DEFINITIONS)) {
      const original = tracked[name];
      if (typeof original !== 'function') continue;
      if ((original as { [wrappedMethods]?: boolean })[wrappedMethods]) continue;

      const bound = (original as (...args: unknown[]) => Promise<unknown>).bind(client);
      const wrapped = (...args: unknown[]) =>
        this.trackRedisCommand(this.extractRedisArgsFromCommand(commandDef, args), () => bound(...args));
      (wrapped as { [wrappedMethods]?: boolean })[wrappedMethods] = true;
      tracked[name] = wrapped;
    }

    const originalSendCommand = client.sendCommand.bind(client);
    client.sendCommand = ((args, options) => {
      const startMs = performance.now();
      this.incrementCommandCount(args);
      try {
        return this.attachUsageTrackingToResult(originalSendCommand(args, options), args, startMs);
      } catch (error) {
        this.recordSendCommandUsage(
          args,
          startMs,
          'error',
          error instanceof Error ? error.message : String(error)
        );
        throw error;
      }
    }) as typeof client.sendCommand;

    const originalMultiExecutor = tracked.multiExecutor.bind(client);
    tracked.multiExecutor = (async (...multiArgs: unknown[]) => {
      const commands = multiArgs[0] as Array<{ args: Array<string | Buffer> }>;
      const trackedCommands = commands.map(({ args }) => {
        this.incrementCommandCount(args);
        return { args, startMs: performance.now() };
      });

      try {
        const result = await originalMultiExecutor(...multiArgs);
        for (const { args, startMs } of trackedCommands) {
          this.recordSendCommandUsage(args, startMs, 'ok');
        }
        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        for (const { args, startMs } of trackedCommands) {
          this.recordSendCommandUsage(args, startMs, 'error', errorMessage);
        }
        throw error;
      }
    }) as typeof tracked.multiExecutor;
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

      // Hook command paths used by node-redis v4 (.get/.set/.multi/.evalSha, etc.)
      this.wrapClientForUsageTracking(this.client);

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

  /** ISO timestamp when this RedisService instance was constructed. */
  getStatsSince(): string {
    return this.startedAtIso;
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
