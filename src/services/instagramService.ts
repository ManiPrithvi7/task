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
// TEMP STIMULATE — remove after testing
import { isStimulateDevice, shouldSkipForStimulate } from '../utils/stimulateAllowlist';
import { getInfluxService } from './influxService';
import { getActiveDeviceCache } from './deviceService';
import {
  fetchInstagramProfileMetrics,
  IG_PROFILE_API_ENDPOINT,
  InstagramProfileFetchError
} from '../lib/socials/instagramMetrics';
import { ensureFreshInstagramAccessToken } from '../lib/socials/instagramTokenRefresh';
import { buildInstagramScreenPayload, buildScreenEnvelope, getInstagramMegaCrossedMilestones } from './screenEnvelope';
import { REDIS_KEYS } from '../constants/redisKeys';
import { computeVelocityPerDay } from '../utils/velocityPerDay';
import {
  LocalBudgetTracker,
  LocalCircuitGate,
  LocalDeviceBackoff,
  LocalFetchDedupe,
  consumeFetchBudget,
  type CircuitGate,
  type DeviceBackoff,
  type FetchDedupe,
  type BudgetTracker
} from './igPollCoordination';
import {
  getIgDeviceRuntimeCache,
  syncScreenFieldImmediate
} from './igDeviceRuntimeCache';
import { getIgAccountFetchCoordinator } from './igAccountFetchCoordinator';
import { notifyWebappFollowerUpdate } from './webappFollowerWebhook';
import { Social, Provider } from '../models/Social';
import { getUserIntegrations } from './userIntegrationCache';

export { REDIS_KEYS };

let sharedCircuitGate: CircuitGate | null = null;

function getOutcomeCircuitGate(): CircuitGate {
  if (!sharedCircuitGate) {
    sharedCircuitGate = new LocalCircuitGate();
  }
  return sharedCircuitGate;
}

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

// ============================================================
// SCRIPT LOAD + EVALSHA helpers (instagramPollingScripts.ts)
// ============================================================

export interface InstagramPollingScriptSha {
  priorityReadPrune: string;
}

let loadedSha: InstagramPollingScriptSha | null = null;

function isNoScript(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('NOSCRIPT');
}

export async function loadInstagramPollingScripts(redis: RedisClientType, force = false): Promise<InstagramPollingScriptSha> {
  if (loadedSha && !force) return loadedSha;

  const priorityReadPrune = await redis.scriptLoad(atomicPriorityReadAndPruneLua);

  loadedSha = { priorityReadPrune };
  logger.info('[IG_POLLING_SCRIPTS] Loaded Lua scripts for EVALSHA', {
    priorityReadPrune,
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

export function resetInstagramPollingScriptsCache(): void {
  loadedSha = null;
}

export function getInstagramPollingScriptSha(): InstagramPollingScriptSha | null {
  return loadedSha;
}

// ============================================================
// Graph API client (via @proof-socials/socials — src/lib/socials/instagramMetrics.ts)
// ============================================================

export type InstagramFetchTrigger = 'attention' | 'scheduled' | 'connect';

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
  userId?: string;
  cacheHit: boolean;
  apiEndpoint?: string;
  primaryResponseSha256?: string;
  detailsResponseSha256?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchInstagramMetrics(
  deviceId: string,
  account: InstagramAccountInfo,
  opts?: { trigger?: InstagramFetchTrigger; retryCount?: number }
): Promise<InstagramFetchResult> {
  const startTime = Date.now();
  const trigger = opts?.trigger ?? 'scheduled';
  const retryCount = opts?.retryCount ?? 0;
  const coordinator = getIgAccountFetchCoordinator();
  const decision = coordinator.decideFetch(account.instagramAccountId, trigger);

  if (decision.action === 'cache_hit') {
    return {
      success: true,
      metrics: {
        followers_count: decision.followersCount,
        ...(decision.username ? { username: decision.username } : {}),
        followers_delta_24h: 0,
        impressions_day: 0,
        impressions_week: 0,
        reach_day: 0,
        reach_week: 0,
        profile_views: 0,
        media_count: 0,
        engagement_rate: 0
      },
      apiResponseTimeMs: Date.now() - startTime,
      instagramAccountId: account.instagramAccountId,
      userId: account.userId || undefined,
      cacheHit: true,
      apiEndpoint: IG_PROFILE_API_ENDPOINT
    };
  }

  try {
    logger.info('📸 [INSTAGRAM] Fetching metrics', {
      deviceId,
      accountId: account.instagramAccountId,
      attempt: retryCount + 1
    });

    const accessToken = await ensureFreshInstagramAccessToken({
      deviceId,
      accessToken: account.accessToken,
      userId: account.userId || undefined
    });

    const profileResult = await fetchInstagramProfileMetrics(accessToken);
    if (!profileResult) {
      return {
        success: false,
        error: 'Instagram profile metrics unavailable',
        apiResponseTimeMs: Date.now() - startTime,
        instagramAccountId: account.instagramAccountId,
        userId: account.userId || undefined,
        cacheHit: false,
        apiEndpoint: IG_PROFILE_API_ENDPOINT
      };
    }

    const fields = profileResult.metrics;
    const audit = profileResult.audit;

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

    coordinator.recordFetch(account.instagramAccountId, trigger, {
      followersCount: metrics.followers_count,
      username: metrics.username
    });

    return {
      success: true,
      metrics,
      apiResponseTimeMs,
      instagramAccountId: account.instagramAccountId,
      userId: account.userId || undefined,
      cacheHit: false,
      apiEndpoint: audit.apiEndpoint,
      primaryResponseSha256: audit.primaryResponseSha256,
      detailsResponseSha256: audit.detailsResponseSha256,
      httpStatus: audit.httpStatus
    };
  } catch (error: unknown) {
    const apiResponseTimeMs = Date.now() - startTime;
    const err =
      error instanceof InstagramProfileFetchError
        ? error
        : (error as Error & {
            code?: string | number;
            httpStatus?: number;
            retryAfterSeconds?: number;
          });

    if (err.httpStatus === 429) {
      const retryAfterSeconds = typeof err.retryAfterSeconds === 'number' ? err.retryAfterSeconds : 60;
      coordinator.setBackoff(account.instagramAccountId, retryAfterSeconds);
      logger.warn('⛔ [INSTAGRAM] HTTP 429 — opening circuit upstream', { deviceId, retryAfterSeconds, apiResponseTimeMs });
      return {
        success: false,
        error: err.message || 'HTTP 429 Too Many Requests',
        httpStatus: 429,
        retryAfterSeconds,
        apiResponseTimeMs,
        instagramAccountId: account.instagramAccountId,
        userId: account.userId || undefined,
        cacheHit: false,
        apiEndpoint: err instanceof InstagramProfileFetchError ? err.apiEndpoint : IG_PROFILE_API_ENDPOINT,
        primaryResponseSha256:
          err instanceof InstagramProfileFetchError ? err.primaryResponseSha256 : undefined
      };
    }

    if (err.httpStatus === 401) {
      coordinator.setBackoff(account.instagramAccountId, 300);
      void Social.updateOne(
        { socialAccountId: account.instagramAccountId, provider: Provider.INSTAGRAM },
        { $set: { needsReauth: true } }
      ).catch(() => undefined);
    }

    const errorCode = err.code;
    const errorMsg = err.message || 'Unknown error';

    if ((errorCode === 4 || errorCode === 32 || errorCode === 17) && retryCount < 3) {
      const delay = Math.pow(2, retryCount) * 1000;
      logger.warn('⏳ [INSTAGRAM] Rate limited by API, retrying', { deviceId, retryCount, delay, errorCode });
      await sleep(delay);
      return fetchInstagramMetrics(deviceId, account, { trigger, retryCount: retryCount + 1 });
    }

    logger.error('❌ [INSTAGRAM] Failed to fetch metrics', { deviceId, errorMsg, errorCode, retryCount, apiResponseTimeMs });
    return {
      success: false,
      error: errorMsg,
      errorCode,
      apiResponseTimeMs,
      instagramAccountId: account.instagramAccountId,
      userId: account.userId || undefined,
      cacheHit: false,
      httpStatus: err.httpStatus,
      apiEndpoint: err instanceof InstagramProfileFetchError ? err.apiEndpoint : IG_PROFILE_API_ENDPOINT,
      primaryResponseSha256:
        err instanceof InstagramProfileFetchError ? err.primaryResponseSha256 : undefined
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
  user_id?: string;
  instagram_account_id?: string;
};

function getCrossedMilestones(oldF: number, newF: number): number[] {
  return getInstagramMegaCrossedMilestones(oldF, newF);
}

export function formatInstagramScreenMqttPayload(
  result: ScreenDeliveryFetchShape,
  topicRoot: string
): { topic: string; payload: string } {
  const { deviceId, data } = result;
  const followers = data?.followers_count ?? 0;
  const handle = data?.instagram_username?.trim().replace(/^@/, '') || '';
  const qrText = handle ? `https://instagram.com/${handle}` : 'https://www.instagram.com/';

  const { payload: screenPayload, envelopeOpts } = buildInstagramScreenPayload({ followers, qrText });
  const envelope = buildScreenEnvelope('instagram', screenPayload, {
    ...envelopeOpts,
    timestamp: new Date(result.fetched_at)
  });

  const out: Record<string, unknown> = { ...envelope };
  if (result.correlation_id) {
    out.correlation_id = result.correlation_id;
  }

  return {
    topic: `${topicRoot}/${deviceId}/instagram`,
    payload: JSON.stringify(out)
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

  const runtime = getIgDeviceRuntimeCache();
  const next = result.data.followers_count;
  const cached = runtime.getFollowers(deviceId);
  const lastPubMs = runtime.getLastPub(deviceId);
  forceHeartbeat = !lastPubMs || (nowMs - lastPubMs) > HEARTBEAT_MS;
  unchanged = typeof cached === 'number' && cached === next;

  if (unchanged && !forceHeartbeat) {
    logger.debug('[IG_SCREEN] No follower change, skip MQTT', { deviceId, followers: next });
    return;
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

    const influx = getInfluxService();
    if (influx) {
      try {
        const payloadSha256 = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
        await influx.writeMqttDelivery(
          {
            platform: 'instagram',
            deviceId,
            success: true,
            payloadSizeBytes: Buffer.byteLength(payload, 'utf8'),
            correlationId: result.correlation_id,
            payloadSha256,
            timestamp: new Date()
          },
          { flush: false }
        );
      } catch (influxErr: unknown) {
        logger.error('[IG_SCREEN] Influx MQTT delivery write failed', {
          deviceId,
          error: influxErr instanceof Error ? influxErr.message : String(influxErr)
        });
      }
    }

    runtime.setFollowers(deviceId, result.data.followers_count);
    runtime.setLastPub(deviceId, nowMs);
    void syncScreenFieldImmediate(deviceId, 'ig_follower_count', result.data.followers_count);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('[IG_SCREEN] MQTT publish failed', { deviceId, error: errMsg });

    const influx = getInfluxService();
    if (influx) {
      try {
        const payloadSha256 = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
        await influx.writeMqttDelivery(
          {
            platform: 'instagram',
            deviceId,
            success: false,
            payloadSizeBytes: Buffer.byteLength(payload, 'utf8'),
            correlationId: result.correlation_id,
            payloadSha256,
            errorMessage: errMsg,
            timestamp: new Date()
          },
          { flush: false }
        );
      } catch (influxErr: unknown) {
        logger.error('[IG_SCREEN] Influx MQTT delivery write failed', {
          deviceId,
          error: influxErr instanceof Error ? influxErr.message : String(influxErr)
        });
      }
    }
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
  userId?: string;
  media_count?: number;
  api_response_time_ms?: number;
  cache_hit?: boolean;
  http_status?: number;
  retry_after_seconds?: number;
  error_code?: string | number;
  api_endpoint?: string;
  primary_response_sha256?: string;
  details_response_sha256?: string;
};

async function readCachedFollowers(deviceId: string): Promise<number | null> {
  const n = getIgDeviceRuntimeCache().getFollowers(deviceId);
  return n !== undefined ? n : null;
}

async function maybeOpenCircuitFromOutcome(row: NormalizedDeviceFetchResult): Promise<void> {
  try {
    const breaker = getOutcomeCircuitGate();

    if (!row.success && row.http_status === 429 && row.retry_after_seconds != null) {
      const secs = Math.max(1, Math.floor(row.retry_after_seconds));
      await breaker.open(secs, 'http_429');
      igPollMetricsInc('circuitOpenEvents');
      logger.warn('[IG_SERVERLESS] Circuit opened (429 Retry-After)', { deviceId: row.deviceId, secs });
      return;
    }

    const rateLimitCodes = new Set<string>(['4', '17', '32', 'RATE_LIMIT_GLOBAL', 'RATE_LIMIT_DEVICE', 'RATE_LIMIT_BURST']);
    const code = row.error_code !== undefined ? String(row.error_code) : null;
    if (!row.success && code && rateLimitCodes.has(code)) {
      await breaker.open(60, 'api_throttle_code');
      igPollMetricsInc('circuitOpenEvents');
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
  const userId = row.userId?.trim() || 'unknown';
  const auditTs = new Date(row.fetched_at);

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
    ...(cid ? { correlation_id: cid } : {}),
    ...(row.userId?.trim() ? { user_id: row.userId.trim() } : {}),
    ...(igAccount ? { instagram_account_id: igAccount } : {})
  };

  const influx = getInfluxService();
  if (influx) {
    try {
      const auditInput = {
        deviceId,
        userId,
        success: row.success,
        triggerType: trigger,
        correlationId: cid,
        instagramAccountId: igAccount || undefined,
        oldFollowers,
        newFollowers,
        durationMs: apiMs,
        httpStatus: row.http_status,
        retryAfterSeconds: row.retry_after_seconds,
        cacheHit: row.cache_hit,
        apiEndpoint: row.api_endpoint,
        primaryResponseSha256: row.primary_response_sha256,
        detailsResponseSha256: row.details_response_sha256,
        errorMessage: row.success ? undefined : (row.error || 'unknown'),
        errorCode: row.success ? undefined : row.error_code,
        timestamp: auditTs
      };

      let igMetricsInput;
      if (row.success && row.followers_count != null) {
        igMetricsInput = {
          deviceId,
          igId: igAccount || 'unknown',
          trigger,
          followersCount: row.followers_count,
          timestamp: auditTs,
        };
      }

      let baselineInput;
      if (row.success && row.followers_count != null && oldFollowers === null) {
        baselineInput = {
          deviceId,
          platform: 'instagram' as const,
          followers: row.followers_count,
          connectedAt: auditTs,
          timestamp: auditTs
        };
      }

      const milestoneInputs: Array<{
        deviceId: string;
        igId: string;
        followersCount: number;
        velocity: number;
        createdAt: string;
        timestamp: Date;
      }> = [];

      if (row.success && newFollowers !== null && oldFollowers !== null && igAccount) {
        const runtime = getIgDeviceRuntimeCache();
        const lastTs = runtime.getLastFollowerCountTimestamp(deviceId);
        const velocity = computeVelocityPerDay(oldFollowers, newFollowers, lastTs ?? null, auditTs.getTime());
        for (const _milestone of getCrossedMilestones(oldFollowers, newFollowers)) {
          milestoneInputs.push({
            deviceId,
            igId: igAccount,
            followersCount: newFollowers,
            velocity,
            createdAt: auditTs.toISOString(),
            timestamp: auditTs,
          });
        }
        runtime.setFollowers(deviceId, newFollowers, auditTs.getTime());
      }

      await influx.writeInstagramOutcomeBatch({
        audit: auditInput,
        igMetrics: igMetricsInput,
        baseline: baselineInput,
        milestones: milestoneInputs.length ? milestoneInputs : undefined,
        e2e:
          e2eMs !== undefined && cid
            ? { deviceId, triggerType: trigger, latencyMs: e2eMs, timestamp: auditTs }
            : undefined,
      });
    } catch (err: unknown) {
      logger.error('[IG_SERVERLESS] Influx write failed', {
        deviceId,
        trigger,
        correlationId: cid,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  if (row.success && newFollowers !== null && igAccount) {
    try {
      await Social.updateOne(
        { socialAccountId: igAccount, provider: Provider.INSTAGRAM },
        { $set: { followerCount: newFollowers, lastSyncedAt: auditTs, needsReauth: false } }
      );
    } catch (err: unknown) {
      logger.warn('[IG_SERVERLESS] Mongo follower sync failed', {
        deviceId,
        igAccount,
        error: err instanceof Error ? err.message : String(err)
      });
    }

    if (oldFollowers !== null && newFollowers !== oldFollowers && userId !== 'unknown') {
      void notifyWebappFollowerUpdate({
        userId,
        instagramAccountId: igAccount,
        followerCount: newFollowers,
        previousCount: oldFollowers,
        syncedAt: auditTs
      });
    }
  }

  await publishInstagramScreenIfChanged(mqttClient, topicRoot, screenShape);

  if (influx) {
    try {
      await influx.flushWrites();
    } catch (err: unknown) {
      logger.error('[IG_SERVERLESS] Influx flush failed', {
        deviceId,
        trigger,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
}

// ============================================================
// Fetch invoker interface + serverless bridge (instagramServerlessBridge.ts)
// ============================================================

export interface InstagramFetchInvoker {
  isConfigured(): boolean;
  invokeFetch(
    deviceIds: string[],
    opts: { trigger: InstagramFetchTrigger; correlationId?: string }
  ): Promise<boolean>;
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

  const userIdRaw =
    typeof raw.userId === 'string'
      ? raw.userId
      : typeof raw.user_id === 'string'
        ? raw.user_id
        : nested && typeof nested.userId === 'string'
          ? nested.userId
          : nested && typeof nested.user_id === 'string'
            ? nested.user_id
            : undefined;

  const mediaCount =
    typeof raw.media_count === 'number'
      ? raw.media_count
      : nested && typeof nested.media_count === 'number'
        ? nested.media_count
        : undefined;

  return {
    deviceId,
    success,
    fetched_at,
    ...(followers !== undefined ? { followers_count: followers } : {}),
    ...(typeof igUsernameRaw === 'string' && igUsernameRaw.trim() ? { instagram_username: igUsernameRaw.trim() } : {}),
    ...(typeof userIdRaw === 'string' && userIdRaw.trim() ? { userId: userIdRaw.trim() } : {}),
    ...(mediaCount !== undefined ? { media_count: mediaCount } : {}),
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
    const breaker = getOutcomeCircuitGate();
    await breaker.open(Math.ceil(secs), 'serverless_circuit_open');
    igPollMetricsInc('circuitOpenEvents');
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
    opts: { trigger: InstagramFetchTrigger; correlationId?: string }
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
        await getOutcomeCircuitGate().open(retryAfter, 'http_429');
        igPollMetricsInc('circuitOpenEvents');
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
    const attentionLike = opts.trigger === 'attention' || opts.trigger === 'connect';
    const cid =
      opts.correlationId && deviceIds.length === 1 && attentionLike ? opts.correlationId : undefined;

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
    row.media_count = result.metrics.media_count;
    if (result.metrics.username?.trim()) {
      row.instagram_username = result.metrics.username.trim();
    }
  }
  if (result.userId?.trim()) {
    row.userId = result.userId.trim();
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
  if (result.apiEndpoint) {
    row.api_endpoint = result.apiEndpoint;
  }
  if (result.primaryResponseSha256) {
    row.primary_response_sha256 = result.primaryResponseSha256;
  }
  if (result.detailsResponseSha256) {
    row.details_response_sha256 = result.detailsResponseSha256;
  }
  return row;
}

async function resolveDeviceMeta(deviceId: string): Promise<ResolvedMeta | null> {
  return getIgDeviceRuntimeCache().resolveMeta(deviceId);
}

export class InstagramDirectFetchInvoker implements InstagramFetchInvoker {
  constructor(private readonly mqttClient: MqttClientManager) {}

  isConfigured(): boolean {
    return true;
  }

  async invokeFetch(
    deviceIds: string[],
    opts: { trigger: InstagramFetchTrigger; correlationId?: string }
  ): Promise<boolean> {
    const topicRoot = this.mqttClient.getTopicRoot();
    let successes = 0;
    const attentionLike = opts.trigger === 'attention' || opts.trigger === 'connect';
    const cid =
      opts.correlationId && deviceIds.length === 1 && attentionLike ? opts.correlationId : undefined;

    const concurrency = 4;
    const queue = [...deviceIds];

    const runOne = async (deviceId: string): Promise<void> => {
      if (await shouldSkipForStimulate(deviceId, 'instagram')) {
        logger.info('[STIM_SKIP] Instagram direct fetch skipped for stim device', {
          deviceId,
          trigger: opts.trigger
        });
        return;
      }
      const meta = await resolveDeviceMeta(deviceId);

      if (!meta) {
        const level = attentionLike ? 'info' : 'debug';
        logger[level]('[IG_DIRECT] No Instagram credentials (Redis proof.mqtt:device:{id} or active-devices.json)', {
          deviceId,
          trigger: opts.trigger
        });
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
        return;
      }

      const result = await fetchInstagramMetrics(deviceId, {
        accessToken: meta.accessToken,
        instagramAccountId: meta.instagramAccountId,
        userId: meta.userId || ''
      }, { trigger: opts.trigger });

      const row = toNormalizedRow(deviceId, result);
      await applyInstagramServerlessDeviceOutcome(row, this.mqttClient, topicRoot, opts.trigger, cid);
      if (result.success) successes++;
    };

    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      // ponytail: worker pool drains shared queue until empty
      // eslint-disable-next-line no-constant-condition
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
  useLocalCircuit: boolean;
  useLocalBackoff: boolean;
  useLocalBudget: boolean;
  useLocalDedupe: boolean;
  useLocalFairOffset: boolean;
}

export class InstagramPoller {
  private priorityTimer: NodeJS.Timeout | null = null;
  private backgroundTimer: NodeJS.Timeout | null = null;
  private running = false;
  private scriptsReady = false;
  private localPriorityZsetSize = 0;
  private readonly circuitGate: CircuitGate;
  private readonly backoff: DeviceBackoff;
  private readonly budget: BudgetTracker;
  private readonly dedupe: FetchDedupe;
  private localFairStart = 0;

  constructor(
    private readonly fetchInvoker: InstagramFetchInvoker | null,
    private readonly redisService: RedisService,
    private readonly config: InstagramPollerConfig
  ) {
    // Phase 4: always local — useLocal* config fields ignored
    this.circuitGate = getOutcomeCircuitGate();
    sharedCircuitGate = this.circuitGate;
    this.backoff = new LocalDeviceBackoff(config.backoffThreshold, config.backoffWindowMs);
    this.budget = new LocalBudgetTracker();
    this.dedupe = new LocalFetchDedupe();
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

    try {
      this.localPriorityZsetSize = await this.redisService
        .getClient()
        .zCard(REDIS_KEYS.priorityZset);
    } catch {
      this.localPriorityZsetSize = 0;
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

  /** Keep local ZSET size in sync when a device is removed (e.g. LWT disconnect). */
  notifyPriorityQueueMemberRemoved(_deviceId?: string): void {
    this.localPriorityZsetSize = Math.max(0, this.localPriorityZsetSize - 1);
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

    const prevRaw = await client.zScore(REDIS_KEYS.priorityZset, deviceId);
    const wasMember = prevRaw !== null && prevRaw !== undefined;

    const refreshCap = this.config.priorityRefreshMaxDeltaMs;
    if (refreshCap > 0 && wasMember) {
      const prevMs = Number(prevRaw);
      if (!Number.isNaN(prevMs)) {
        expiry = Math.min(expiry, prevMs + refreshCap);
      }
    }

    expiry = Math.max(expiry, now);

    await client.zAdd(REDIS_KEYS.priorityZset, [{ score: expiry, value: deviceId }]);
    if (!wasMember) {
      this.localPriorityZsetSize += 1;
    }

    const maxMembers = this.config.priorityZsetMaxMembers;
    if (maxMembers > 0) {
      const card = await client.zCard(REDIS_KEYS.priorityZset);
      if (card > maxMembers) {
        await client.zRemRangeByRank(REDIS_KEYS.priorityZset, 0, card - maxMembers - 1);
        this.localPriorityZsetSize = maxMembers;
        igPollMetricsInc('priorityZsetTrims');
      }
    }
  }

  async requestImmediateFetch(
    deviceId: string,
    opts?: { trigger?: InstagramFetchTrigger }
  ): Promise<boolean> {
    const trigger: InstagramFetchTrigger = opts?.trigger ?? 'attention';
    if (!this.running || !this.scriptsReady || !this.fetchInvoker?.isConfigured() || !this.redisService.isRedisConnected()) {
      return false;
    }

    try {
      if (await shouldSkipForStimulate(deviceId, 'instagram')) {
        logger.info('[STIM_SKIP] Instagram immediate fetch skipped for stim device', { deviceId, trigger });
        return false;
      }
      if (await this.circuitGate.isOpen()) return false;

      const allowed = await this.backoff.shouldAllow(deviceId);
      if (!allowed) {
        igPollMetricsInc('attentionImmediateBackoffSkip');
        return false;
      }

      if (!(await this.dedupe.tryAcquire(deviceId, this.config.fetchDedupeWindowMs))) {
        return false;
      }

      if (!(await consumeFetchBudget(this.budget, this.config.globalFetchBudgetPerMinute))) {
        igPollMetricsInc('fetchBudgetRejects');
        return false;
      }

      const correlationId = crypto.randomUUID();
      registerAttentionCorrelationStart(correlationId);
      const ok = await this.fetchInvoker.invokeFetch([deviceId], {
        trigger,
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

  private filterOutPowerSave(deviceIds: string[]): string[] {
    if (deviceIds.length === 0) return [];
    const runtime = getIgDeviceRuntimeCache();
    return deviceIds.filter((id) => !runtime.getPowerSave(id));
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

    let start = (this.localFairStart % n + n) % n;

    const rotated = start ? [...sorted.slice(start), ...sorted.slice(0, start)] : sorted;
    const windowIds = rotated.slice(0, limit);

    const advance = cap > 0 ? Math.min(cap, n) : n;
    const nextStart = (start + advance) % Math.max(1, n);
    this.localFairStart = nextStart;
    igPollMetricsInc('backgroundFairRotateCycles');

    return windowIds;
  }

  private canRun(): boolean {
    return this.running && this.scriptsReady && this.redisService.isRedisConnected();
  }

  private isRedisReady(): boolean {
    return this.redisService.isRedisConnected();
  }

  private isTransientRedisError(err: unknown): boolean {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'ECONNRESET' || code === 'NR_CLOSED' || code === 'ECONNREFUSED';
  }

  private logSchedulerError(scope: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    if (this.isTransientRedisError(err)) {
      logger.debug(`[IG_POLLER] ${scope} transient Redis error`, {
        error: msg,
        code: (err as NodeJS.ErrnoException)?.code
      });
    } else {
      logger.error(`[IG_POLLER] ${scope} error`, { error: msg });
    }
  }

  private async safeRedisCall<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err: unknown) {
      if (this.isTransientRedisError(err)) {
        logger.debug('[IG_POLLER] Redis transient error, using fallback', {
          label,
          code: (err as NodeJS.ErrnoException)?.code
        });
        return fallback;
      }
      throw err;
    }
  }

  private async priorityScheduler(): Promise<void> {
    if (!this.canRun()) return;
    if (!this.isRedisReady()) return;
    const fetchInvoker = this.fetchInvoker;
    if (!fetchInvoker?.isConfigured()) return;

    try {
      igPollMetricsInc('priorityCycles');
      if (await this.circuitGate.isOpen()) {
        logger.debug('[IG_POLLER] Circuit open, skipping priority cycle');
        igPollMetricsInc('circuitOpenSkips');
        return;
      }

      const redis = this.redisService.getClient();
      if (this.localPriorityZsetSize === 0) return;

      let active = await this.safeRedisCall(
        'priorityReadPrune',
        () => evalAtomicPriorityReadAndPruneEvalSha(redis, Date.now()),
        [] as string[]
      );
      this.localPriorityZsetSize = active.length;
      if (active.length === 0) return;
      // TEMP STIMULATE — remove after testing: skip stim devices (allowlist + lock)
      active = active.filter((id) => !isStimulateDevice(id));
      if (active.length > 0 && this.redisService.isRedisConnected()) {
        const filtered: string[] = [];
        for (const id of active) {
          if (!(await shouldSkipForStimulate(id, 'instagram'))) filtered.push(id);
        }
        active = filtered;
      }
      const cap = this.config.priorityCapPerCycle;
      if (cap > 0 && active.length > cap) {
        active = active.slice(0, cap);
      }

      const eligible: string[] = [];

      for (const deviceId of active) {
        if (!(await this.backoff.shouldAllow(deviceId))) continue;
        if (!(await this.dedupe.tryAcquire(deviceId, this.config.fetchDedupeWindowMs))) continue;
        if (!(await consumeFetchBudget(this.budget, this.config.globalFetchBudgetPerMinute))) {
          igPollMetricsInc('fetchBudgetRejects');
          break;
        }
        eligible.push(deviceId);
      }

      if (eligible.length === 0) return;

      for (const batch of chunk(eligible, this.config.batchSize)) {
        if (await this.circuitGate.isOpen()) break;
        const ok = await fetchInvoker.invokeFetch(batch, { trigger: 'scheduled' });
        if (ok) {
          batch.forEach(() => igPollMetricsInc('fetchesEnqueued'));
        }
      }
    } catch (err: unknown) {
      this.logSchedulerError('Priority scheduler', err);
    }
  }

  private async backgroundScheduler(): Promise<void> {
    if (!this.canRun()) return;
    if (!this.isRedisReady()) return;
    const fetchInvoker = this.fetchInvoker;
    if (!fetchInvoker?.isConfigured()) return;

    try {
      igPollMetricsInc('backgroundCycles');
      if (await this.circuitGate.isOpen()) {
        logger.debug('[IG_POLLER] Circuit open, skipping background cycle');
        igPollMetricsInc('circuitOpenSkips');
        return;
      }

      const redis = this.redisService.getClient();
      const nowMs = Date.now();

      // Background pool should be derived from the server-persisted active device cache
      // to avoid split-brain between Redis registries and local state.
      const allActive = await getActiveDeviceCache().getAllActive();
      let allDeviceIds = allActive.map((d) => d.deviceId).filter(Boolean);
      // TEMP STIMULATE — remove after testing: skip stim devices (allowlist + lock)
      allDeviceIds = allDeviceIds.filter((id) => !isStimulateDevice(id));
      if (allDeviceIds.length > 0 && this.redisService.isRedisConnected()) {
        const filtered: string[] = [];
        for (const id of allDeviceIds) {
          if (!(await shouldSkipForStimulate(id, 'instagram'))) filtered.push(id);
        }
        allDeviceIds = filtered;
      }

      // Subtract devices currently in the active priority window (Redis zset).
      // IMPORTANT: do NOT use evalAtomicPriorityReadAndPruneEvalSha here; it is destructive (prunes the zset).
      const priorityActive = await this.safeRedisCall(
        'priorityZset',
        () => redis.zRangeByScore(REDIS_KEYS.priorityZset, nowMs, '+inf'),
        [] as string[]
      );
      const prioritySet = new Set(priorityActive);
      let devicesRaw = allDeviceIds.filter((id) => !prioritySet.has(id));

      const integrationsByUser = new Map<string, boolean>();
      const withInstagram: string[] = [];
      for (const deviceId of devicesRaw) {
        const active = allActive.find((d) => d.deviceId === deviceId);
        const uid = active?.userId;
        if (!uid) continue;
        if (!integrationsByUser.has(uid)) {
          const integrations = await getUserIntegrations(uid);
          integrationsByUser.set(uid, Boolean(integrations?.instagram));
        }
        if (integrationsByUser.get(uid)) withInstagram.push(deviceId);
      }
      devicesRaw = withInstagram;

      const filtered = this.filterOutPowerSave(devicesRaw);
      const devices = await this.takeBackgroundWindow(filtered);
      if (devices.length === 0) return;

      const eligible: string[] = [];
      for (const deviceId of devices) {
        if (!(await this.backoff.shouldAllow(deviceId))) continue;
        if (!(await this.dedupe.tryAcquire(deviceId, this.config.fetchDedupeWindowMs))) continue;
        if (!(await consumeFetchBudget(this.budget, this.config.globalFetchBudgetPerMinute))) {
          igPollMetricsInc('fetchBudgetRejects');
          break;
        }
        eligible.push(deviceId);
      }

      if (eligible.length === 0) return;

      for (const batch of chunk(eligible, this.config.batchSize)) {
        if (await this.circuitGate.isOpen()) break;
        const ok = await fetchInvoker.invokeFetch(batch, { trigger: 'scheduled' });
        if (ok) {
          batch.forEach(() => igPollMetricsInc('fetchesEnqueued'));
        }
      }
    } catch (err: unknown) {
      this.logSchedulerError('Background scheduler', err);
    }
  }
}
