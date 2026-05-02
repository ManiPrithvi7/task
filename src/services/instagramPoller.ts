import crypto from 'crypto';
import { logger } from '../utils/logger';
import type { InstagramFetchInvoker } from './instagramServerlessBridge';
import { RedisService } from './redisService';
import { InstagramCircuitBreaker } from './instagramCircuitBreaker';
import { REDIS_KEYS } from './instagramPollingLua';
import {
  evalAtomicBackoffCheckAndRecordEvalSha,
  evalAtomicBackgroundSubtractionEvalSha,
  evalAtomicFetchBudgetTryEvalSha,
  evalAtomicPriorityReadAndPruneEvalSha,
  loadInstagramPollingScripts
} from './instagramPollingScripts';
import {
  abandonAttentionCorrelation,
  igPollMetricsInc,
  registerAttentionCorrelationStart
} from './instagramPollingMetrics';

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
  /** 0 = no cap (process all priority members each tick). */
  priorityCapPerCycle: number;
  /** 0 = dedupe disabled. Same-device publish suppression window from poller. */
  fetchDedupeWindowMs: number;
  /**
   * Max members in priority_zset (Phase C). When exceeded, lowest-score (soonest-expiring) entries are removed.
   * 0 = unlimited.
   */
  priorityZsetMaxMembers: number;
  /**
   * On repeat attention, cap how far into the future the score can move per touch: min(now+ttl, prevScore+Δ).
   * 0 = off (full ttl refresh each time).
   */
  priorityRefreshMaxDeltaMs: number;
  /**
   * Hard cap: score cannot exceed now + this (epoch ceiling). 0 = off.
   */
  priorityAbsoluteMaxFutureMs: number;
  /**
   * Max background candidates considered per tick after fair rotation (Phase C starvation guard). 0 = all.
   */
  backgroundCapPerCycle: number;
  /** When true, rotate through `full_active_set` over successive ticks using a shared Redis cursor. */
  backgroundFairRotate: boolean;
  /**
   * Max serverless fetch invocations (all poller paths) per rolling minute. 0 = unlimited.
   */
  globalFetchBudgetPerMinute: number;
}

/**
 * Dual scheduler for Instagram polling (HTTP → serverless Graph fetch).
 * Uses SCRIPT LOAD + EVALSHA for Lua atomics (with NOSCRIPT reload fallback).
 */
export class InstagramPoller {
  private priorityTimer: NodeJS.Timeout | null = null;
  private backgroundTimer: NodeJS.Timeout | null = null;
  private running = false;
  private scriptsReady = false;
  private circuit: InstagramCircuitBreaker;

  constructor(
    private readonly fetchInvoker: InstagramFetchInvoker | null,
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
      backoff: { threshold: this.config.backoffThreshold, windowMs: this.config.backoffWindowMs },
      fairness: {
        priorityZsetMaxMembers: this.config.priorityZsetMaxMembers,
        backgroundCapPerCycle: this.config.backgroundCapPerCycle,
        backgroundFairRotate: this.config.backgroundFairRotate,
        globalFetchBudgetPerMinute: this.config.globalFetchBudgetPerMinute
      }
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

  /** Score = expiry epoch ms (now + ttl), with optional refresh / ceiling caps (Phase C). */
  async markPriority(deviceId: string, ttlMs?: number): Promise<void> {
    const client = this.redisService.getClient();
    const ttl = ttlMs ?? this.config.priorityTtlMs;
    const now = Date.now();
    let expiry = now + ttl;

    const maxFuture = this.config.priorityAbsoluteMaxFutureMs;
    if (maxFuture > 0) {
      expiry = Math.min(expiry, now + maxFuture);
    }

    const refreshCap = this.config.priorityRefreshMaxDeltaMs;
    if (refreshCap > 0) {
      const prevRaw = await client.zScore(REDIS_KEYS.priorityZset, deviceId);
      if (prevRaw !== null && prevRaw !== undefined) {
        const prevMs = Number(prevRaw);
        if (!Number.isNaN(prevMs)) {
          expiry = Math.min(expiry, prevMs + refreshCap);
        }
      }
    }

    expiry = Math.max(expiry, now);

    await client.zAdd(REDIS_KEYS.priorityZset, [{ score: expiry, value: deviceId }]);

    const maxMembers = this.config.priorityZsetMaxMembers;
    if (maxMembers > 0) {
      const card = await client.zCard(REDIS_KEYS.priorityZset);
      if (card > maxMembers) {
        await client.zRemRangeByRank(REDIS_KEYS.priorityZset, 0, card - maxMembers - 1);
        igPollMetricsInc('priorityZsetTrims');
      }
    }
  }

  /**
   * Immediate fetch after device registration / NFC scan path: backoff + dedupe + budget,
   * then POST to serverless worker (Instagram Graph runs there).
   */
  async requestImmediateFetch(deviceId: string): Promise<boolean> {
    if (!this.running || !this.scriptsReady || !this.fetchInvoker?.isConfigured() || !this.redisService.isRedisConnected()) {
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
      if (!allowed) {
        igPollMetricsInc('attentionImmediateBackoffSkip');
        return false;
      }

      if (!(await this.reserveFetchDedupe(deviceId))) {
        igPollMetricsInc('attentionImmediateBackoffSkip');
        return false;
      }

      if (!(await this.consumeGlobalFetchBudget())) {
        return false;
      }

      const correlationId = crypto.randomUUID();
      registerAttentionCorrelationStart(correlationId);
      const ok = await this.fetchInvoker.invokeFetch([deviceId], {
        trigger: 'attention',
        correlationId
      });
      if (!ok) {
        abandonAttentionCorrelation(correlationId);
        return false;
      }
      igPollMetricsInc('attentionImmediateSuccess');
      igPollMetricsInc('fetchesEnqueued');
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

  getRunning(): boolean {
    return this.running;
  }

  getScriptsReady(): boolean {
    return this.scriptsReady;
  }

  private async reserveFetchDedupe(deviceId: string): Promise<boolean> {
    const w = this.config.fetchDedupeWindowMs;
    if (!w || w <= 0) return true;
    try {
      const key = `ig:fetch_dedupe:${deviceId}`;
      const ok = await this.redisService.getClient().set(key, '1', { PX: w, NX: true });
      if (ok === null) {
        igPollMetricsInc('fetchesDeduped');
        return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  /** Rolling minute bucket; shared across instances via Redis + atomic Lua (no over-count on reject). */
  private async consumeGlobalFetchBudget(): Promise<boolean> {
    const limit = this.config.globalFetchBudgetPerMinute;
    if (!limit || limit <= 0) return true;
    try {
      const slot = Math.floor(Date.now() / 60_000);
      const key = `ig:poll:global_fetch_budget:${slot}`;
      const ok = await evalAtomicFetchBudgetTryEvalSha(this.redisService.getClient(), key, limit);
      if (!ok) {
        igPollMetricsInc('fetchBudgetRejects');
        return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  private async filterOutPowerSave(deviceIds: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const id of deviceIds) {
      try {
        const on = await this.redisService.getClient().exists(REDIS_KEYS.igPowerSave(id));
        if (!on) out.push(id);
      } catch {
        out.push(id);
      }
    }
    return out;
  }

  /**
   * Stable sort + optional Redis-backed round-robin + cap (Phase C background starvation guard).
   */
  private async takeBackgroundWindow(deviceIds: string[]): Promise<string[]> {
    if (deviceIds.length === 0) return [];
    const sorted = [...deviceIds].sort();
    const n = sorted.length;
    const cap = this.config.backgroundCapPerCycle;
    const limit = cap > 0 ? Math.min(cap, n) : n;

    if (!this.config.backgroundFairRotate || n <= 1) {
      return sorted.slice(0, limit);
    }

    const redis = this.redisService.getClient();
    let start = 0;
    try {
      const raw = await redis.get(REDIS_KEYS.backgroundFairnessOffset);
      if (raw) start = (parseInt(raw, 10) % n + n) % n;
    } catch {
      /* ignore */
    }

    const rotated = start ? [...sorted.slice(start), ...sorted.slice(0, start)] : sorted;
    const windowIds = rotated.slice(0, limit);

    try {
      const advance = cap > 0 ? Math.min(cap, n) : n;
      const nextStart = (start + advance) % Math.max(1, n);
      await redis.set(REDIS_KEYS.backgroundFairnessOffset, String(nextStart));
      igPollMetricsInc('backgroundFairRotateCycles');
    } catch {
      /* ignore */
    }

    return windowIds;
  }

  private canRun(): boolean {
    return this.running && this.scriptsReady && this.redisService.isRedisConnected();
  }

  private async priorityScheduler(): Promise<void> {
    if (!this.canRun()) return;
    const fetchInvoker = this.fetchInvoker;
    if (!fetchInvoker?.isConfigured()) return;

    try {
      igPollMetricsInc('priorityCycles');
      if (await this.circuit.isOpen()) {
        logger.debug('[IG_POLLER] Circuit open, skipping priority cycle');
        igPollMetricsInc('circuitOpenSkips');
        return;
      }

      const redis = this.redisService.getClient();
      let active = await evalAtomicPriorityReadAndPruneEvalSha(redis, Date.now());
      if (active.length === 0) return;
      const cap = this.config.priorityCapPerCycle;
      if (cap > 0 && active.length > cap) {
        active = active.slice(0, cap);
      }

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
        if (!allowed) continue;
        if (!(await this.reserveFetchDedupe(deviceId))) continue;
        if (!(await this.consumeGlobalFetchBudget())) break;
        eligible.push(deviceId);
      }

      if (eligible.length === 0) return;

      for (const batch of chunk(eligible, this.config.batchSize)) {
        if (await this.circuit.isOpen()) break;
        const ok = await fetchInvoker.invokeFetch(batch, { trigger: 'scheduled' });
        if (ok) {
          batch.forEach(() => igPollMetricsInc('fetchesEnqueued'));
        }
      }
    } catch (err: unknown) {
      logger.error('[IG_POLLER] Priority scheduler error', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async backgroundScheduler(): Promise<void> {
    if (!this.canRun()) return;
    const fetchInvoker = this.fetchInvoker;
    if (!fetchInvoker?.isConfigured()) return;

    try {
      igPollMetricsInc('backgroundCycles');
      if (await this.circuit.isOpen()) {
        logger.debug('[IG_POLLER] Circuit open, skipping background cycle');
        igPollMetricsInc('circuitOpenSkips');
        return;
      }

      const redis = this.redisService.getClient();
      const devicesRaw = await evalAtomicBackgroundSubtractionEvalSha(redis, Date.now());
      const filtered = await this.filterOutPowerSave(devicesRaw);
      const devices = await this.takeBackgroundWindow(filtered);
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
        if (!allowed) continue;
        if (!(await this.reserveFetchDedupe(deviceId))) continue;
        if (!(await this.consumeGlobalFetchBudget())) break;
        eligible.push(deviceId);
      }

      if (eligible.length === 0) return;

      for (const batch of chunk(eligible, this.config.batchSize)) {
        if (await this.circuit.isOpen()) break;
        const ok = await fetchInvoker.invokeFetch(batch, { trigger: 'scheduled' });
        if (ok) {
          batch.forEach(() => igPollMetricsInc('fetchesEnqueued'));
        }
      }
    } catch (err: unknown) {
      logger.error('[IG_POLLER] Background scheduler error', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
