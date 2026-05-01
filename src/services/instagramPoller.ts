import crypto from 'crypto';
import { logger } from '../utils/logger';
import { KafkaService } from './kafkaService';
import { RedisService } from './redisService';
import { InstagramCircuitBreaker } from './instagramCircuitBreaker';
import { REDIS_KEYS } from './instagramPollingLua';
import {
  evalAtomicBackoffCheckAndRecordEvalSha,
  evalAtomicBackgroundSubtractionEvalSha,
  evalAtomicPriorityReadAndPruneEvalSha,
  loadInstagramPollingScripts
} from './instagramPollingScripts';

function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export interface InstagramPollerConfig {
  priorityIntervalMs: number;
  backgroundIntervalMs: number;
  priorityTtlMs: number;
  batchSize: number;
  backoffThreshold: number;
  backoffWindowMs: number;
}

/**
 * Dual scheduler for Instagram polling (Kafka fetch requests).
 * Uses SCRIPT LOAD + EVALSHA for Lua atomics (with NOSCRIPT reload fallback).
 */
export class InstagramPoller {
  private priorityTimer: NodeJS.Timeout | null = null;
  private backgroundTimer: NodeJS.Timeout | null = null;
  private running = false;
  private scriptsReady = false;
  private circuit: InstagramCircuitBreaker;

  constructor(
    private readonly kafka: KafkaService | null,
    private readonly redisService: RedisService,
    private readonly config: InstagramPollerConfig
  ) {
    this.circuit = new InstagramCircuitBreaker(this.redisService.getClient());
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      await loadInstagramPollingScripts(this.redisService.getClient());
      this.scriptsReady = true;
    } catch (err: unknown) {
      logger.error('[IG_POLLER] Failed to SCRIPT LOAD polling Lua scripts', {
        error: err instanceof Error ? err.message : String(err)
      });
      this.running = false;
      throw err;
    }

    logger.info('⏱️ [IG_POLLER] Starting dual schedulers', {
      priorityIntervalMs: this.config.priorityIntervalMs,
      backgroundIntervalMs: this.config.backgroundIntervalMs,
      batchSize: this.config.batchSize,
      backoff: { threshold: this.config.backoffThreshold, windowMs: this.config.backoffWindowMs }
    });

    this.priorityTimer = setInterval(() => void this.priorityScheduler(), this.config.priorityIntervalMs);
    this.backgroundTimer = setInterval(() => void this.backgroundScheduler(), this.config.backgroundIntervalMs);
    void this.priorityScheduler();
    void this.backgroundScheduler();
  }

  stop(): void {
    this.running = false;
    if (this.priorityTimer) clearInterval(this.priorityTimer);
    if (this.backgroundTimer) clearInterval(this.backgroundTimer);
    this.priorityTimer = null;
    this.backgroundTimer = null;
    logger.info('🛑 [IG_POLLER] Stopped');
  }

  /** Score = expiry epoch ms (now + ttl). */
  async markPriority(deviceId: string, ttlMs?: number): Promise<void> {
    const client = this.redisService.getClient();
    const ttl = ttlMs ?? this.config.priorityTtlMs;
    const expiry = Date.now() + ttl;
    await client.zAdd(REDIS_KEYS.priorityZset, [{ score: expiry, value: deviceId }]);
  }

  /**
   * Optional immediate fetch after attention: respects circuit breaker + sliding-window backoff,
   * then enqueues a single Kafka fetch request (does not bypass InstagramRateLimiter inside consumer).
   */
  async requestImmediateFetch(deviceId: string): Promise<boolean> {
    if (!this.running || !this.scriptsReady || !this.kafka?.connected || !this.redisService.isRedisConnected()) {
      return false;
    }

    try {
      if (await this.circuit.isOpen()) return false;

      const redis = this.redisService.getClient();
      const allowed = await evalAtomicBackoffCheckAndRecordEvalSha(
        redis,
        deviceId,
        Date.now(),
        crypto.randomUUID(),
        this.config.backoffThreshold,
        this.config.backoffWindowMs
      );
      if (!allowed) return false;

      await this.kafka.publishInstagramFetchRequest(deviceId, 'attention');
      return true;
    } catch (err: unknown) {
      logger.warn('[IG_POLLER] requestImmediateFetch failed', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
      return false;
    }
  }

  async isCircuitOpen(): Promise<boolean> {
    return this.circuit.isOpen();
  }

  private canRun(): boolean {
    return this.running && this.scriptsReady && this.redisService.isRedisConnected();
  }

  private async priorityScheduler(): Promise<void> {
    if (!this.canRun()) return;
    if (!this.kafka?.connected) return;

    try {
      if (await this.circuit.isOpen()) {
        logger.debug('[IG_POLLER] Circuit open, skipping priority cycle');
        return;
      }

      const redis = this.redisService.getClient();
      const active = await evalAtomicPriorityReadAndPruneEvalSha(redis, Date.now());
      if (active.length === 0) return;

      const eligible: string[] = [];
      const nowMs = Date.now();

      for (const deviceId of active) {
        const allowed = await evalAtomicBackoffCheckAndRecordEvalSha(
          redis,
          deviceId,
          nowMs,
          crypto.randomUUID(),
          this.config.backoffThreshold,
          this.config.backoffWindowMs
        );
        if (allowed) eligible.push(deviceId);
      }

      if (eligible.length === 0) return;

      for (const batch of chunk(eligible, this.config.batchSize)) {
        if (await this.circuit.isOpen()) break;
        await Promise.all(
          batch.map((deviceId) => this.kafka!.publishInstagramFetchRequest(deviceId, 'scheduled'))
        );
      }
    } catch (err: unknown) {
      logger.error('[IG_POLLER] Priority scheduler error', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async backgroundScheduler(): Promise<void> {
    if (!this.canRun()) return;
    if (!this.kafka?.connected) return;

    try {
      if (await this.circuit.isOpen()) {
        logger.debug('[IG_POLLER] Circuit open, skipping background cycle');
        return;
      }

      const redis = this.redisService.getClient();
      const devices = await evalAtomicBackgroundSubtractionEvalSha(redis, Date.now());
      if (devices.length === 0) return;

      const eligible: string[] = [];
      const nowMs = Date.now();
      for (const deviceId of devices) {
        const allowed = await evalAtomicBackoffCheckAndRecordEvalSha(
          redis,
          deviceId,
          nowMs,
          crypto.randomUUID(),
          this.config.backoffThreshold,
          this.config.backoffWindowMs
        );
        if (allowed) eligible.push(deviceId);
      }

      if (eligible.length === 0) return;

      for (const batch of chunk(eligible, this.config.batchSize)) {
        if (await this.circuit.isOpen()) break;
        await Promise.all(
          batch.map((deviceId) => this.kafka!.publishInstagramFetchRequest(deviceId, 'scheduled'))
        );
      }
    } catch (err: unknown) {
      logger.error('[IG_POLLER] Background scheduler error', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
