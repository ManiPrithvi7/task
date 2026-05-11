// Placeholder
/**
 * Instagram Service (single-file implementation)
 *
 * This file intentionally contains the full Instagram feature surface:
 * - Polling scheduler (priority + background)
 * - Redis Lua atomics + SCRIPT LOAD/EVALSHA helpers
 * - Circuit breaker + in-process metrics
 * - Serverless bridge + direct fetch invoker
 * - Graph API client + MQTT screen delivery + Influx audit hooks
 *
 * Goal: the rest of the app imports Instagram features from **this file only**.
 */

import crypto from 'crypto';
import type { RedisClientType } from 'redis';
import { logger } from '../utils/logger';
import type { InstagramServerlessConfig } from '../config';
import type { MqttClientManager } from '../servers/mqttClient';
import { getRedisService } from './redisService';
import type { RedisService } from './redisService';
import { getInfluxService } from './influxService';
import { getActiveDeviceCache } from './deviceService';

const igLocalFollowersCache = new Map<string, number>();
const igLocalLastPublishMs = new Map<string, number>();

const getCircuitBreaker = (() => {
  let instance: InstagramCircuitBreaker | null = null;
  let boundClient: RedisClientType | null = null;
  return (client: RedisClientType): InstagramCircuitBreaker => {
    if (!instance || boundClient !== client) {
      boundClient = client;
      instance = new InstagramCircuitBreaker(client);
    }
    return instance;
  };
})();

// ============================================================
// Polling metrics (instagramPollingMetrics.ts)
// ============================================================

const LATENCY_RING_MAX = 512;

const counters = {
  priorityCycles: 0,
  backgroundCycles: 0,
  fetchesEnqueued: 0,
  fetchesDeduped: 0,
  /** Redis failures in dedupe reservation; dedupe disabled on these paths. */
  fetchDedupeRedisErrors: 0,
  attentionImmediateSuccess: 0,
  attentionImmediateBackoffSkip: 0,
  circuitOpenSkips: 0,
  /** Circuit breaker entered open state (API / throttle). */
  circuitOpenEvents: 0,
  /** Global per-minute fetch budget rejected a publish. */
  fetchBudgetRejects: 0,
  /** Priority zset trimmed because it exceeded max members. */
  priorityZsetTrims: 0,
  /** Background scheduler advanced fair-rotation cursor. */
  backgroundFairRotateCycles: 0
};

export type IgPollCounterKey = keyof typeof counters;

export function igPollMetricsInc(key: IgPollCounterKey, n = 1): void {
  counters[key] += n;
}

/** Register start time when an attention immediate fetch is invoked (before serverless POST). */
const correlationStartMs = new Map<string, number>();
const MAX_CORRELATION_PENDING = 10_000;

export function registerAttentionCorrelationStart(correlationId: string): void {
  if (!correlationId) return;
  if (correlationStartMs.size >= MAX_CORRELATION_PENDING) {
    let evict = 100;
    for (const k of correlationStartMs.keys()) {
      correlationStartMs.delete(k);
      if (--evict === 0) break;
    }
  }
  correlationStartMs.set(correlationId, Date.now());
}

/** Drop pending E2E timer without recording (fetch failed or early exit). */
export function abandonAttentionCorrelation(correlationId: string | undefined): void {
  if (!correlationId) return;
  correlationStartMs.delete(correlationId);
}

let ringHead = 0;
let ringCount = 0;
const latencyRing = new Float64Array(LATENCY_RING_MAX);

function recordLatencySample(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  latencyRing[ringHead] = ms;
  ringHead = (ringHead + 1) % LATENCY_RING_MAX;
  ringCount = Math.min(LATENCY_RING_MAX, ringCount + 1);
}

function percentile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

export interface AttentionE2eLatencySnapshot {
  count: number;
  sumMs: number;
  minMs?: number;
  maxMs?: number;
  p50ApproxMs?: number;
  p95ApproxMs?: number;
}

function buildLatencySnapshot(): AttentionE2eLatencySnapshot {
  if (ringCount === 0) {
    return { count: 0, sumMs: 0 };
  }
  const arr: number[] = new Array(ringCount);
  const start = ringCount === LATENCY_RING_MAX ? ringHead : 0;
  for (let i = 0; i < ringCount; i++) {
    arr[i] = latencyRing[(start + i) % LATENCY_RING_MAX]!;
  }
  const sorted = arr.sort((a, b) => a - b);
  const sumMs = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    sumMs,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    p50ApproxMs: percentile(sorted, 0.5),
    p95ApproxMs: percentile(sorted, 0.95)
  };
}

export function observeAttentionFetchLatencyMs(correlationId: string | undefined): number | undefined {
  if (!correlationId) return undefined;
  const t0 = correlationStartMs.get(correlationId);
  if (t0 === undefined) return undefined;
  correlationStartMs.delete(correlationId);
  const ms = Date.now() - t0;
  recordLatencySample(ms);
  return ms;
}

export function getInstagramPollingMetricsSnapshot(): Record<string, unknown> {
  return {
    ...counters,
    attentionE2eLatencyMs: buildLatencySnapshot()
  };
}

// ============================================================
// Redis keys + Lua atomics (instagramPollingLua.ts)
// ============================================================

export const REDIS_KEYS = {
  priorityZset: 'priority_zset',
  circuitBlockedUntil: 'instagram:circuit:blocked_until',
  deviceFollowers: (deviceId: string) => `device:followers:${deviceId}`,
  deviceFetchHistory: (deviceId: string) => `device:fetch_history:${deviceId}`,
  /** Firmware/device deferred background polling (Phase G); TTL refreshed on MQTT /active payload. */
  igPowerSave: (deviceId: string) => `ig:power_save:${deviceId}`,
  /** Round-robin cursor for background device fairness (Phase C). */
  backgroundFairnessOffset: 'ig:bg:fair_offset'
} as const;

export const atomicPriorityReadAndPruneLua = `
local active = redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], '+inf')
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
return active
`.trim();

export const atomicBackoffCheckAndRecordLua = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local uuid = ARGV[2]
local threshold = tonumber(ARGV[3])
local window = tonumber(ARGV[4])
local start = now - window

redis.call('ZREMRANGEBYSCORE', key, '-inf', start)
local count = redis.call('ZCOUNT', key, start, now)

if count >= threshold then
  return 0
end

redis.call('ZADD', key, now, uuid)
redis.call('EXPIRE', key, math.ceil(window/1000) + 1)
return 1
`.trim();

export const atomicFetchBudgetTryLua = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then
  redis.call('EXPIRE', KEYS[1], 120)
end
local lim = tonumber(ARGV[1])
if lim <= 0 then
  return 1
end
if c > lim then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
`.trim();

export async function evalAtomicPriorityReadAndPrune(redis: RedisClientType, nowMs: number): Promise<string[]> {
  const res = await redis.eval(atomicPriorityReadAndPruneLua, {
    keys: [REDIS_KEYS.priorityZset],
    arguments: [String(nowMs)]
  });
  return Array.isArray(res) ? (res as string[]) : [];
}

export async function evalAtomicBackoffCheckAndRecord(
  redis: RedisClientType,
  deviceId: string,
  nowMs: number,
  uuid: string,
  threshold: number,
  windowMs: number
): Promise<boolean> {
  const res = await redis.eval(atomicBackoffCheckAndRecordLua, {
    keys: [REDIS_KEYS.deviceFetchHistory(deviceId)],
    arguments: [String(nowMs), uuid, String(threshold), String(windowMs)]
  });
  return String(res) === '1';
}

export async function evalAtomicFetchBudgetTry(redis: RedisClientType, budgetKey: string, limit: number): Promise<boolean> {
  const res = await redis.eval(atomicFetchBudgetTryLua, { keys: [budgetKey], arguments: [String(limit)] });
  return String(res) === '1';
}

// ============================================================
// SCRIPT LOAD + EVALSHA helpers (instagramPollingScripts.ts)
// ============================================================

export interface InstagramPollingScriptSha {
  priorityReadPrune: string;
  backoffCheckRecord: string;
  fetchBudgetTry: string;
}

let loadedSha: InstagramPollingScriptSha | null = null;

function isNoScript(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('NOSCRIPT');
}

export async function loadInstagramPollingScripts(redis: RedisClientType, force = false): Promise<InstagramPollingScriptSha> {
  if (loadedSha && !force) return loadedSha;

  const [priorityReadPrune, backoffCheckRecord, fetchBudgetTry] = await Promise.all([
    redis.scriptLoad(atomicPriorityReadAndPruneLua),
    redis.scriptLoad(atomicBackoffCheckAndRecordLua),
    redis.scriptLoad(atomicFetchBudgetTryLua)
  ]);

  loadedSha = { priorityReadPrune, backoffCheckRecord, fetchBudgetTry };
  logger.info('[IG_POLLING_SCRIPTS] Loaded Lua scripts for EVALSHA', {
    priorityReadPrune,
    backoffCheckRecord,
    fetchBudgetTry,
    forceReload: force
  });
  return loadedSha;
}

export function areInstagramPollingScriptsLoaded(): boolean {
  return loadedSha !== null;
}

async function evalShaWithFallback(
  redis: RedisClientType,
  pickSha: (s: InstagramPollingScriptSha) => string,
  keys: string[],
  arguments_: string[]
): Promise<unknown> {
  let registry = await loadInstagramPollingScripts(redis);
  try {
    return await redis.evalSha(pickSha(registry), { keys, arguments: arguments_ });
  } catch (err: unknown) {
    if (!isNoScript(err)) throw err;
    registry = await loadInstagramPollingScripts(redis, true);
    return redis.evalSha(pickSha(registry), { keys, arguments: arguments_ });
  }
}

export async function evalAtomicPriorityReadAndPruneEvalSha(redis: RedisClientType, nowMs: number): Promise<string[]> {
  const res = await evalShaWithFallback(redis, (s) => s.priorityReadPrune, [REDIS_KEYS.priorityZset], [String(nowMs)]);
  return Array.isArray(res) ? (res as string[]) : [];
}

export async function evalAtomicBackoffCheckAndRecordEvalSha(
  redis: RedisClientType,
  deviceId: string,
  nowMs: number,
  uuid: string,
  threshold: number,
  windowMs: number
): Promise<boolean> {
  const res = await evalShaWithFallback(
    redis,
    (s) => s.backoffCheckRecord,
    [REDIS_KEYS.deviceFetchHistory(deviceId)],
    [String(nowMs), uuid, String(threshold), String(windowMs)]
  );
  return String(res) === '1';
}

export async function evalAtomicFetchBudgetTryEvalSha(redis: RedisClientType, budgetKey: string, limit: number): Promise<boolean> {
  const res = await evalShaWithFallback(redis, (s) => s.fetchBudgetTry, [budgetKey], [String(limit)]);
  return String(res) === '1';
}

export function resetInstagramPollingScriptsCache(): void {
  loadedSha = null;
}

export function getInstagramPollingScriptSha(): InstagramPollingScriptSha | null {
  return loadedSha;
}

// ============================================================
// Circuit breaker (instagramCircuitBreaker.ts)
// ============================================================

export class InstagramCircuitBreaker {
  private redis: RedisClientType;
  private local: { isOpen: boolean; resetTimeMs: number } = { isOpen: false, resetTimeMs: 0 };
  private lastRedisCheckMs = 0;

  constructor(redis: RedisClientType, private readonly cacheTtlMs = 5000) {
    this.redis = redis;
  }

  async isOpen(): Promise<boolean> {
    const now = Date.now();

    if (now - this.lastRedisCheckMs < this.cacheTtlMs) {
      return this.local.isOpen && now < this.local.resetTimeMs;
    }

    const blockedUntilRaw = await this.redis.get(REDIS_KEYS.circuitBlockedUntil);
    this.lastRedisCheckMs = now;

    const blockedUntil = blockedUntilRaw ? parseInt(blockedUntilRaw, 10) : 0;
    if (blockedUntil && blockedUntil > now) {
      this.local = { isOpen: true, resetTimeMs: blockedUntil };
      return true;
    }

    this.local = { isOpen: false, resetTimeMs: 0 };
    return false;
  }

  async open(retryAfterSeconds: number): Promise<void> {
    const safeSeconds = Math.max(1, Math.floor(retryAfterSeconds));
    const resetTimeMs = Date.now() + safeSeconds * 1000;

    await this.redis.set(REDIS_KEYS.circuitBlockedUntil, String(resetTimeMs), {
      EX: safeSeconds + 60
    });

    igPollMetricsInc('circuitOpenEvents');
    this.local = { isOpen: true, resetTimeMs };
    this.lastRedisCheckMs = Date.now();
  }

  async reset(): Promise<void> {
    await this.redis.del(REDIS_KEYS.circuitBlockedUntil);
    this.local = { isOpen: false, resetTimeMs: 0 };
    this.lastRedisCheckMs = Date.now();
  }

  getLocalState(): { isOpen: boolean; resetTimeMs: number } {
    return { ...this.local };
  }
}

// ============================================================
// Graph API client (instagramApiClient.ts)
// ============================================================

const GRAPH_BASE = 'graph.instagram.com';
const API_VERSION = 'v22.0';

export interface InstagramAccountInfo {
  accessToken: string;
  instagramAccountId: string;
  userId: string;
}

export interface InstagramMetrics {
  followers_count: number;
  username?: string;
  followers_delta_24h: number;
  impressions_day: number;
  impressions_week: number;
  reach_day: number;
  reach_week: number;
  profile_views: number;
  media_count: number;
  engagement_rate: number;
}

export interface InstagramFetchResult {
  success: boolean;
  metrics?: InstagramMetrics;
  error?: string;
  errorCode?: string | number;
  httpStatus?: number;
  retryAfterSeconds?: number;
  apiResponseTimeMs: number;
  instagramAccountId: string;
  cacheHit: boolean;
}

function httpsGet(url: string): Promise<Record<string, unknown>> {
  return (async () => {
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(15_000) });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Instagram API request failed: ${msg}`);
    }

    if (res.status === 429) {
      const rawRa = res.headers.get('retry-after');
      let retryAfterSeconds = 60;
      if (rawRa) {
        const n = parseInt(String(rawRa), 10);
        if (Number.isFinite(n) && n > 0) retryAfterSeconds = n;
      }
      throw Object.assign(new Error('HTTP 429 Too Many Requests'), { httpStatus: 429, retryAfterSeconds });
    }

    const text = await res.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    } catch {
      throw new Error(`Failed to parse Instagram API response (${res.status}): ${text.slice(0, 200)}`);
    }

    if (parsed.error && typeof parsed.error === 'object') {
      const ge = parsed.error as { message?: string; code?: number; type?: string };
      throw Object.assign(new Error(ge.message || 'Instagram API error'), { code: ge.code, type: ge.type });
    }

    return parsed;
  })();
}

async function fetchAccountFields(
  accountId: string,
  accessToken: string
): Promise<{ followers_count: number; media_count: number; username?: string }> {
  const url = `https://${GRAPH_BASE}/${API_VERSION}/${accountId}?fields=followers_count,media_count,username&access_token=${accessToken}`;
  const data = (await httpsGet(url)) as { followers_count?: number; media_count?: number; username?: string };
  return {
    followers_count: typeof data.followers_count === 'number' ? data.followers_count : 0,
    media_count: typeof data.media_count === 'number' ? data.media_count : 0,
    ...(typeof data.username === 'string' && data.username.trim() ? { username: data.username.trim() } : {})
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchInstagramMetrics(
  deviceId: string,
  account: InstagramAccountInfo,
  retryCount = 0
): Promise<InstagramFetchResult> {
  const startTime = Date.now();

  try {
    logger.info('📸 [INSTAGRAM] Fetching metrics', {
      deviceId,
      accountId: account.instagramAccountId,
      attempt: retryCount + 1
    });

    const fields = await fetchAccountFields(account.instagramAccountId, account.accessToken);
    const apiResponseTimeMs = Date.now() - startTime;

    const metrics: InstagramMetrics = {
      followers_count: fields.followers_count,
      ...(fields.username ? { username: fields.username } : {}),
      followers_delta_24h: 0,
      impressions_day: 0,
      impressions_week: 0,
      reach_day: 0,
      reach_week: 0,
      profile_views: 0,
      media_count: fields.media_count,
      engagement_rate: 0
    };

    logger.info('✅ [INSTAGRAM] Metrics fetched successfully', { deviceId, followers: metrics.followers_count, apiResponseTimeMs });

    return {
      success: true,
      metrics,
      apiResponseTimeMs,
      instagramAccountId: account.instagramAccountId,
      cacheHit: false
    };
  } catch (error: unknown) {
    const apiResponseTimeMs = Date.now() - startTime;
    const err = error as Error & {
      code?: string | number;
      httpStatus?: number;
      retryAfterSeconds?: number;
    };

    if (err.httpStatus === 429) {
      const retryAfterSeconds = typeof err.retryAfterSeconds === 'number' ? err.retryAfterSeconds : 60;
      logger.warn('⛔ [INSTAGRAM] HTTP 429 — opening circuit upstream', { deviceId, retryAfterSeconds, apiResponseTimeMs });
      return {
        success: false,
        error: err.message || 'HTTP 429 Too Many Requests',
        httpStatus: 429,
        retryAfterSeconds,
        apiResponseTimeMs,
        instagramAccountId: account.instagramAccountId,
        cacheHit: false
      };
    }

    const errorCode = err.code;
    const errorMsg = err.message || 'Unknown error';

    if ((errorCode === 4 || errorCode === 32 || errorCode === 17) && retryCount < 3) {
      const delay = Math.pow(2, retryCount) * 1000;
      logger.warn('⏳ [INSTAGRAM] Rate limited by API, retrying', { deviceId, retryCount, delay, errorCode });
      await sleep(delay);
      return fetchInstagramMetrics(deviceId, account, retryCount + 1);
    }

    logger.error('❌ [INSTAGRAM] Failed to fetch metrics', { deviceId, errorMsg, errorCode, retryCount, apiResponseTimeMs });
    return {
      success: false,
      error: errorMsg,
      errorCode,
      apiResponseTimeMs,
      instagramAccountId: account.instagramAccountId,
      cacheHit: false
    };
  }
}

// ============================================================
// Screen delivery (instagramScreenDelivery.ts)
// ============================================================

export type ScreenDeliveryFetchShape = {
  deviceId: string;
  success: boolean;
  fetched_at: string;
  data?: { followers_count: number; instagram_username?: string };
  error?: string;
  correlation_id?: string;
};

function getNextMilestone(followers: number): number {
  const milestones = [100, 500, 1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];
  return milestones.find((m) => m > followers) ?? Math.ceil(followers / 1000) * 1000 + 1000;
}

export function formatInstagramScreenMqttPayload(
  result: ScreenDeliveryFetchShape,
  topicRoot: string
): { topic: string; payload: string } {
  const { deviceId, data } = result;
  const followers = data?.followers_count ?? 0;
  const achievement = getNextMilestone(followers);
  const progress = Math.min(100, Math.round((followers / achievement) * 100));
  const remainingGoal = Math.max(0, achievement - followers);
  const handle = data?.instagram_username?.trim().replace(/^@/, '') || '';
  const qrText = handle ? `https://instagram.com/${handle}` : 'https://www.instagram.com/';

  const envelope: Record<string, unknown> = {
    version: '1.2',
    screen: 'instagram',
    muted: true,
    timestamp: result.fetched_at,
    payload: {
      followers,
      achievement,
      remainingGoal,
      progress,
      qrText
    }
  };
  if (result.correlation_id) {
    envelope.correlation_id = result.correlation_id;
  }

  return {
    topic: `${topicRoot}/${deviceId}/instagram`,
    payload: JSON.stringify(envelope)
  };
}

export async function publishInstagramScreenIfChanged(
  mqttClient: MqttClientManager,
  topicRoot: string,
  result: ScreenDeliveryFetchShape
): Promise<void> {
  const { deviceId, success } = result;
  if (!success || !result.data) {
    logger.warn('[IG_SCREEN] Skipping MQTT for failed fetch', { deviceId, error: result.error });
    return;
  }

  const nowMs = Date.now();
  const HEARTBEAT_MS = 10 * 60 * 1000;
  let forceHeartbeat = false;
  let unchanged = false;

  const redisSvc = getRedisService();
  if (redisSvc?.isRedisConnected()) {
    try {
      const client = redisSvc.getClient();
      const cacheKey = `device:followers:${deviceId}`;
      const cachedRaw = await client.get(cacheKey);
      const cached = cachedRaw !== null ? parseInt(cachedRaw, 10) : null;
      const next = result.data.followers_count;

      const lastPubKey = `ig:last_pub:${deviceId}`;
      const lastPubRaw = await client.get(lastPubKey);
      const lastPubMs = lastPubRaw ? parseInt(lastPubRaw, 10) : 0;
      forceHeartbeat = !lastPubMs || Number.isNaN(lastPubMs) || (nowMs - lastPubMs) > HEARTBEAT_MS;

      unchanged = typeof cached === 'number' && !Number.isNaN(cached) && cached === next;
      if (unchanged && !forceHeartbeat) {
        logger.debug('[IG_SCREEN] No follower change, skip MQTT', { deviceId, followers: next });
        return;
      }
    } catch (err: unknown) {
      logger.warn('[IG_SCREEN] Change detection failed (continuing)', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  } else {
    // Fallback when Redis isn't available: still avoid spamming unchanged values.
    const next = result.data.followers_count;
    const prev = igLocalFollowersCache.get(deviceId);
    unchanged = typeof prev === 'number' && prev === next;

    const lastPubMs = igLocalLastPublishMs.get(deviceId) ?? 0;
    forceHeartbeat = !lastPubMs || (nowMs - lastPubMs) > HEARTBEAT_MS;

    if (unchanged && !forceHeartbeat) {
      logger.debug('[IG_SCREEN] No follower change (local), skip MQTT', { deviceId, followers: next });
      return;
    }
  }

  const cache = getActiveDeviceCache();
  const activeDevices = await cache.getAllActive();
  const isActive = activeDevices.some((d) => d.deviceId === deviceId);

  const { topic, payload } = formatInstagramScreenMqttPayload(result, topicRoot);

  try {
    await mqttClient.publish({ topic, payload, qos: 1, retain: true });
    logger.info('[IG_SCREEN] Published to broker (retained)', {
      deviceId,
      topic,
      followers: result.data.followers_count,
      heartbeat: forceHeartbeat && unchanged
    });

    // Update "last published" markers only after successful publish.
    if (redisSvc?.isRedisConnected()) {
      try {
        const client = redisSvc.getClient();
        await client.set(`device:followers:${deviceId}`, String(result.data.followers_count), { EX: 86400 });
        await client.set(`ig:last_pub:${deviceId}`, String(nowMs), { EX: 86400 });
      } catch (e: unknown) {
        logger.debug('[IG_SCREEN] Redis publish markers update failed (ignored)', {
          deviceId,
          error: e instanceof Error ? e.message : String(e)
        });
      }
    } else {
      igLocalFollowersCache.set(deviceId, result.data.followers_count);
      igLocalLastPublishMs.set(deviceId, nowMs);
    }
  } catch (err: unknown) {
    logger.error('[IG_SCREEN] MQTT publish failed', { deviceId, error: err instanceof Error ? err.message : String(err) });
  }

  if (!isActive) {
    logger.debug('[IG_SCREEN] Device not active in cache (retained publish still applied)', { deviceId });
  }
}

// ============================================================
// Outcome applicator (instagramServerlessOutcome.ts)
// ============================================================

export type NormalizedDeviceFetchResult = {
  deviceId: string;
  success: boolean;
  fetched_at: string;
  followers_count?: number;
  instagram_username?: string;
  error?: string;
  instagram_account_id?: string;
  api_response_time_ms?: number;
  cache_hit?: boolean;
  http_status?: number;
  retry_after_seconds?: number;
  error_code?: string | number;
};

async function readCachedFollowers(deviceId: string): Promise<number | null> {
  const redisSvc = getRedisService();
  if (!redisSvc?.isRedisConnected()) return null;
  try {
    const raw = await redisSvc.getClient().get(REDIS_KEYS.deviceFollowers(deviceId));
    if (raw === null) return null;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

async function maybeOpenCircuitFromOutcome(row: NormalizedDeviceFetchResult): Promise<void> {
  try {
    const redisSvc = getRedisService();
    if (!redisSvc?.isRedisConnected()) return;
    const breaker = getCircuitBreaker(redisSvc.getClient());

    if (!row.success && row.http_status === 429 && row.retry_after_seconds != null) {
      const secs = Math.max(1, Math.floor(row.retry_after_seconds));
      await breaker.open(secs);
      logger.warn('[IG_SERVERLESS] Circuit opened (429 Retry-After)', { deviceId: row.deviceId, secs });
      return;
    }

    const rateLimitCodes = new Set<string>(['4', '17', '32', 'RATE_LIMIT_GLOBAL', 'RATE_LIMIT_DEVICE', 'RATE_LIMIT_BURST']);
    const code = row.error_code !== undefined ? String(row.error_code) : null;
    if (!row.success && code && rateLimitCodes.has(code)) {
      await breaker.open(60);
      logger.warn('[IG_SERVERLESS] Circuit opened (API throttle code)', { deviceId: row.deviceId, code });
    }
  } catch (err: unknown) {
    logger.debug('[IG_SERVERLESS] Circuit breaker hook failed (ignored)', { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function applyInstagramServerlessDeviceOutcome(
  row: NormalizedDeviceFetchResult,
  mqttClient: MqttClientManager,
  topicRoot: string,
  trigger: string,
  correlationId?: string
): Promise<void> {
  const deviceId = row.deviceId;
  const oldFollowers = await readCachedFollowers(deviceId);
  const newFollowers = row.success && row.followers_count != null ? row.followers_count : null;

  await maybeOpenCircuitFromOutcome(row);

  const cid = correlationId;

  if (!row.success) {
    abandonAttentionCorrelation(cid);
  }

  let e2eMs: number | undefined;
  if (cid && row.success) {
    e2eMs = observeAttentionFetchLatencyMs(cid);
  }

  const apiMs = row.api_response_time_ms ?? 0;
  const igAccount = row.instagram_account_id ?? '';
  const auditTs = new Date(row.fetched_at);

  const influx = getInfluxService();
  if (influx) {
    try {
      await influx.writeInstagramFetchAudit(
        {
          deviceId,
          success: row.success,
          triggerType: trigger,
          correlationId: cid,
          instagramAccountId: igAccount || undefined,
          oldFollowers,
          newFollowers,
          durationMs: apiMs,
          errorMessage: row.success ? undefined : (row.error || 'unknown'),
          errorCode: row.success ? undefined : row.error_code,
          timestamp: auditTs
        },
        { flush: false }
      );

      if (row.success && row.followers_count != null) {
        await influx.writeInstagramFollowersGauge(deviceId, igAccount, row.followers_count, auditTs, { flush: false });
      }

      if (e2eMs !== undefined && cid) {
        await influx.writeInstagramAttentionE2eLatency(deviceId, trigger, e2eMs, auditTs, { flush: false });
      }

      await influx.flushWrites();
    } catch (err: unknown) {
      logger.debug('[IG_SERVERLESS] Influx write failed (ignored)', { deviceId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const screenShape: ScreenDeliveryFetchShape = {
    deviceId,
    success: row.success,
    fetched_at: row.fetched_at,
    ...(row.success && row.followers_count != null
      ? {
          data: {
            followers_count: row.followers_count,
            ...(row.instagram_username?.trim() ? { instagram_username: row.instagram_username.trim() } : {})
          }
        }
      : { error: row.error }),
    ...(cid ? { correlation_id: cid } : {})
  };

  await publishInstagramScreenIfChanged(mqttClient, topicRoot, screenShape);
}

// ============================================================
// Fetch invoker interface + serverless bridge (instagramServerlessBridge.ts)
// ============================================================

export interface InstagramFetchInvoker {
  isConfigured(): boolean;
  invokeFetch(deviceIds: string[], opts: { trigger: 'attention' | 'scheduled'; correlationId?: string }): Promise<boolean>;
}

function parseDeviceRow(raw: Record<string, unknown>, fallbackDeviceId?: string): NormalizedDeviceFetchResult | null {
  const deviceId =
    (typeof raw.deviceId === 'string' && raw.deviceId) ||
    (typeof raw.device_id === 'string' && raw.device_id) ||
    fallbackDeviceId;
  if (!deviceId) return null;

  const success = raw.success === true;
  const nested = raw.data && typeof raw.data === 'object' ? (raw.data as Record<string, unknown>) : null;
  const followers =
    typeof raw.followers_count === 'number'
      ? raw.followers_count
      : nested && typeof nested.followers_count === 'number'
        ? nested.followers_count
        : undefined;

  const igUsernameRaw =
    typeof raw.instagram_username === 'string'
      ? raw.instagram_username
      : nested && typeof nested.username === 'string'
        ? nested.username
        : nested && typeof nested.instagram_username === 'string'
          ? nested.instagram_username
          : undefined;

  const fetched_at =
    typeof raw.fetched_at === 'string'
      ? raw.fetched_at
      : typeof raw.timestamp === 'string'
        ? raw.timestamp
        : new Date().toISOString();

  return {
    deviceId,
    success,
    fetched_at,
    ...(followers !== undefined ? { followers_count: followers } : {}),
    ...(typeof igUsernameRaw === 'string' && igUsernameRaw.trim() ? { instagram_username: igUsernameRaw.trim() } : {}),
    ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
    ...(typeof raw.instagram_account_id === 'string' ? { instagram_account_id: raw.instagram_account_id } : {}),
    ...(typeof raw.api_response_time_ms === 'number' ? { api_response_time_ms: raw.api_response_time_ms } : {}),
    ...(typeof raw.cache_hit === 'boolean' ? { cache_hit: raw.cache_hit } : {}),
    ...(typeof raw.http_status === 'number' ? { http_status: raw.http_status } : {}),
    ...(typeof raw.retry_after_seconds === 'number' ? { retry_after_seconds: raw.retry_after_seconds } : {}),
    ...(raw.error_code !== undefined ? { error_code: raw.error_code as string | number } : {})
  };
}

function normalizeResponseBody(body: unknown, requestedIds: string[]): NormalizedDeviceFetchResult[] {
  if (!body || typeof body !== 'object') return [];

  const o = body as Record<string, unknown>;
  const out: NormalizedDeviceFetchResult[] = [];

  if (Array.isArray(o.results)) {
    for (const item of o.results) {
      if (item && typeof item === 'object') {
        const row = parseDeviceRow(item as Record<string, unknown>);
        if (row) out.push(row);
      }
    }
    return out;
  }

  if (o.results && typeof o.results === 'object' && !Array.isArray(o.results)) {
    const map = o.results as Record<string, unknown>;
    for (const [key, val] of Object.entries(map)) {
      if (val && typeof val === 'object') {
        const row = parseDeviceRow(val as Record<string, unknown>, key);
        if (row) out.push(row);
      }
    }
    return out;
  }

  if (typeof o.success === 'boolean' && requestedIds.length === 1) {
    const row = parseDeviceRow(o, requestedIds[0]);
    return row ? [row] : [];
  }

  return [];
}

async function maybeApplyGlobalCircuit(body: unknown): Promise<void> {
  if (!body || typeof body !== 'object') return;
  const secs = (body as { circuit_open_seconds?: unknown }).circuit_open_seconds;
  if (typeof secs !== 'number' || secs <= 0) return;
  try {
    const redisSvc = getRedisService();
    if (!redisSvc?.isRedisConnected()) return;
    const breaker = getCircuitBreaker(redisSvc.getClient());
    await breaker.open(Math.ceil(secs));
    logger.warn('[IG_SERVERLESS] Circuit opened from response payload', { seconds: secs });
  } catch {
    /* ignore */
  }
}

export class InstagramServerlessBridge implements InstagramFetchInvoker {
  constructor(
    private readonly cfg: InstagramServerlessConfig,
    private readonly mqttClient: MqttClientManager
  ) {}

  isConfigured(): boolean {
    return Boolean(this.cfg.fetchUrl?.trim());
  }

  async invokeFetch(
    deviceIds: string[],
    opts: { trigger: 'attention' | 'scheduled'; correlationId?: string }
  ): Promise<boolean> {
    if (!this.isConfigured() || deviceIds.length === 0) return false;

    const url = this.cfg.fetchUrl.trim();
    const timeoutMs = this.cfg.timeoutMs > 0 ? this.cfg.timeoutMs : 30_000;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.cfg.apiKey ? { 'x-api-key': this.cfg.apiKey } : {})
    };

    const body = JSON.stringify({
      deviceIds,
      trigger: opts.trigger,
      ...(opts.correlationId ? { correlation_id: opts.correlationId } : {})
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err: unknown) {
      logger.warn('[IG_SERVERLESS] Fetch failed', {
        error: err instanceof Error ? err.message : String(err),
        deviceCount: deviceIds.length
      });
      return false;
    }

    if (response.status === 429) {
      let retryAfter = 60;
      try {
        const errBody = await response.json();
        if (
          errBody &&
          typeof errBody === 'object' &&
          typeof (errBody as { retry_after_seconds?: number }).retry_after_seconds === 'number'
        ) {
          retryAfter = Math.max(1, Math.floor((errBody as { retry_after_seconds: number }).retry_after_seconds));
        }
        await maybeApplyGlobalCircuit(errBody);
      } catch {
        /* use default */
      }
      try {
        const redisSvc = getRedisService();
        if (redisSvc?.isRedisConnected()) {
          await new InstagramCircuitBreaker(redisSvc.getClient()).open(retryAfter);
        }
      } catch {
        /* ignore */
      }
      logger.warn('[IG_SERVERLESS] HTTP 429 from serverless', { retryAfter });
      return false;
    }

    let parsed: unknown;
    try {
      const text = await response.text();
      parsed = text ? JSON.parse(text) : {};
    } catch {
      logger.warn('[IG_SERVERLESS] Invalid JSON response', { status: response.status });
      return false;
    }

    await maybeApplyGlobalCircuit(parsed);

    if (!response.ok) {
      logger.warn('[IG_SERVERLESS] Non-OK HTTP status', { status: response.status, body: parsed });
    }

    const rows = normalizeResponseBody(parsed, deviceIds);
    if (rows.length === 0) {
      logger.debug('[IG_SERVERLESS] No device rows in response', { requested: deviceIds.length, status: response.status });
      return response.ok;
    }

    const topicRoot = this.mqttClient.getTopicRoot();
    const triggerTag = opts.trigger;
    const cid = opts.correlationId && deviceIds.length === 1 && opts.trigger === 'attention' ? opts.correlationId : undefined;

    const allowed = new Set(deviceIds);
    let applied = 0;
    for (const row of rows) {
      if (!allowed.has(row.deviceId)) continue;
      await applyInstagramServerlessDeviceOutcome(row, this.mqttClient, topicRoot, triggerTag, cid);
      applied++;
    }

    return response.ok || applied > 0;
  }
}

// ============================================================
// Direct fetch invoker (instagramDirectFetchInvoker.ts)
// ============================================================

const DEVICE_META_KEY_PREFIX = 'proof.mqtt:device:';

interface ResolvedMeta {
  instagramAccountId: string;
  accessToken: string;
  userId?: string;
}

function toNormalizedRow(deviceId: string, result: InstagramFetchResult): NormalizedDeviceFetchResult {
  const fetched_at = new Date().toISOString();
  const row: NormalizedDeviceFetchResult = {
    deviceId,
    success: result.success,
    fetched_at,
    instagram_account_id: result.instagramAccountId,
    api_response_time_ms: result.apiResponseTimeMs,
    cache_hit: result.cacheHit
  };
  if (result.success && result.metrics) {
    row.followers_count = result.metrics.followers_count;
    if (result.metrics.username?.trim()) {
      row.instagram_username = result.metrics.username.trim();
    }
  }
  if (!result.success && result.error) {
    row.error = result.error;
  }
  if (result.httpStatus !== undefined) {
    row.http_status = result.httpStatus;
  }
  if (result.retryAfterSeconds !== undefined) {
    row.retry_after_seconds = result.retryAfterSeconds;
  }
  if (result.errorCode !== undefined) {
    row.error_code = result.errorCode;
  }
  return row;
}

async function loadMetaFromRedis(deviceId: string): Promise<ResolvedMeta | null> {
  const redisSvc = getRedisService();
  if (!redisSvc?.isRedisConnected()) return null;
  try {
    const raw = await redisSvc.getClient().get(`${DEVICE_META_KEY_PREFIX}${deviceId}`);
    if (!raw) return null;
    const o = JSON.parse(raw) as Record<string, unknown>;
    const instagramAccountId = typeof o.instagramAccountId === 'string' ? o.instagramAccountId.trim() : '';
    const accessToken = typeof o.accessToken === 'string' ? o.accessToken.trim() : '';
    if (!instagramAccountId || !accessToken) return null;
    return { instagramAccountId, accessToken };
  } catch {
    return null;
  }
}

async function loadMetaFromLocalCache(deviceId: string): Promise<ResolvedMeta | null> {
  const ad = await getActiveDeviceCache().getActive(deviceId);
  if (!ad) return null;
  const instagramAccountId = ad.instagramAccountId?.trim() || '';
  const accessToken = ad.accessToken?.trim() || '';
  if (!instagramAccountId || !accessToken) return null;
  return { instagramAccountId, accessToken, userId: ad.userId };
}

export class InstagramDirectFetchInvoker implements InstagramFetchInvoker {
  constructor(private readonly mqttClient: MqttClientManager) {}

  isConfigured(): boolean {
    return true;
  }

  async invokeFetch(
    deviceIds: string[],
    opts: { trigger: 'attention' | 'scheduled'; correlationId?: string }
  ): Promise<boolean> {
    const topicRoot = this.mqttClient.getTopicRoot();
    let successes = 0;
    const cid = opts.correlationId && deviceIds.length === 1 && opts.trigger === 'attention' ? opts.correlationId : undefined;

    const concurrency = 4;
    const queue = [...deviceIds];

    const runOne = async (deviceId: string): Promise<void> => {
      const fromRedis = await loadMetaFromRedis(deviceId);
      const meta = fromRedis ?? (await loadMetaFromLocalCache(deviceId));

      if (!meta) {
        const level = opts.trigger === 'attention' ? 'info' : 'debug';
        logger[level]('[IG_DIRECT] No Instagram credentials (Redis proof.mqtt:device:{id} or active-devices.json)', {
          deviceId,
          trigger: opts.trigger
        });
        if (opts.trigger === 'attention' && deviceIds.length === 1) {
          await applyInstagramServerlessDeviceOutcome(
            {
              deviceId,
              success: false,
              fetched_at: new Date().toISOString(),
              error: 'no_instagram_credentials'
            },
            this.mqttClient,
            topicRoot,
            opts.trigger,
            cid
          );
        }
        return;
      }

      const result = await fetchInstagramMetrics(deviceId, {
        accessToken: meta.accessToken,
        instagramAccountId: meta.instagramAccountId,
        userId: meta.userId || ''
      });

      const row = toNormalizedRow(deviceId, result);
      await applyInstagramServerlessDeviceOutcome(row, this.mqttClient, topicRoot, opts.trigger, cid);
      if (result.success) successes++;
    };

    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (true) {
        const next = queue.shift();
        if (!next) return;
        await runOne(next);
      }
    });
    await Promise.all(workers);

    return successes > 0;
  }
}

// ============================================================
// Poller (instagramPoller.ts)
// ============================================================

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
  priorityCapPerCycle: number;
  fetchDedupeWindowMs: number;
  priorityZsetMaxMembers: number;
  priorityRefreshMaxDeltaMs: number;
  priorityAbsoluteMaxFutureMs: number;
  backgroundCapPerCycle: number;
  backgroundFairRotate: boolean;
  globalFetchBudgetPerMinute: number;
}

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
    } catch (err: unknown) {
      igPollMetricsInc('fetchDedupeRedisErrors');
      logger.debug('[IG_POLLER] reserveFetchDedupe failed (dedupe disabled for this device)', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
      return true;
    }
  }

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
    if (deviceIds.length === 0) return [];
    try {
      const m = this.redisService.getClient().multi();
      deviceIds.forEach((id) => m.exists(REDIS_KEYS.igPowerSave(id)));
      const res = await m.exec();
      const flags = (Array.isArray(res) ? res : []) as Array<number | null | undefined>;
      return deviceIds.filter((_, i) => (typeof flags[i] === 'number' ? flags[i] : 0) === 0);
    } catch (err: unknown) {
      logger.debug('[IG_POLLER] filterOutPowerSave pipeline failed (treat all as not power-save)', {
        error: err instanceof Error ? err.message : String(err),
        count: deviceIds.length
      });
      return deviceIds;
    }
  }

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
      const nowMs = Date.now();

      // Background pool should be derived from the server-persisted active device cache
      // to avoid split-brain between Redis registries and local state.
      const allActive = await getActiveDeviceCache().getAllActive();
      const allDeviceIds = allActive.map((d) => d.deviceId).filter(Boolean);

      // Subtract devices currently in the active priority window (Redis zset).
      // IMPORTANT: do NOT use evalAtomicPriorityReadAndPruneEvalSha here; it is destructive (prunes the zset).
      const priorityActive = await redis.zRangeByScore(REDIS_KEYS.priorityZset, nowMs, '+inf');
      const prioritySet = new Set(priorityActive);
      const devicesRaw = allDeviceIds.filter((id) => !prioritySet.has(id));

      const filtered = await this.filterOutPowerSave(devicesRaw);
      const devices = await this.takeBackgroundWindow(filtered);
      if (devices.length === 0) return;

      const eligible: string[] = [];
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
