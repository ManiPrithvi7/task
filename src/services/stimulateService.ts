/**
 * TEMP STIMULATE — remove after testing
 * In-process stimulate loops for allowlisted devices (no separate process).
 * Starts when STIMULATE_DEVICE is set; publishes production IG/GMB envelopes.
 */
import type { MqttClientManager } from '../servers/mqttClient';
import type { RedisService } from './redisService';
import { logger } from '../utils/logger';
import { parseStimulateAllowlist } from '../utils/stimulateAllowlist';
import { runIgTick, STIM_IG_LOCK_TTL_SEC, igStimLockKey } from '../../stimulate/igRunner';
import { runGmbTick, STIM_GMB_LOCK_TTL_SEC, gmbStimLockKey } from '../../stimulate/gmbRunner';
import { readStimCache, writeStimCache, clearStimCache } from '../../stimulate/cache';

export type StimulatePlatform = 'instagram' | 'gmb';

type LoopState = {
  deviceId: string;
  platform: StimulatePlatform;
  timer: ReturnType<typeof setInterval> | null;
  lockRefreshTimer: ReturnType<typeof setInterval> | null;
  done: boolean;
};

function parsePlatforms(): StimulatePlatform[] {
  return (process.env.STIMULATE_PLATFORMS || 'instagram,gmb')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is StimulatePlatform => s === 'instagram' || s === 'gmb');
}

function parseStep(): number {
  return Math.max(1, Math.min(5, parseInt(process.env.STIMULATE_STEP || '1', 10) || 1));
}

function parseIntervalMs(): number {
  return Math.max(5000, parseInt(process.env.STIMULATE_INTERVAL_MS || '30000', 10) || 30000);
}

function parseIgTarget(): number {
  return Math.max(1, parseInt(process.env.STIMULATE_IG_TARGET || '500', 10) || 500);
}

function parseGmbTarget(): number {
  return Math.max(1, parseInt(process.env.STIMULATE_GMB_TARGET || '100', 10) || 100);
}

/** Force-set stim lock (in-process owner — no NX race with a second process). */
async function takeStimLock(
  redis: RedisService | null,
  platform: StimulatePlatform,
  deviceId: string
): Promise<void> {
  if (!redis?.isRedisConnected()) return;
  const key = platform === 'instagram' ? igStimLockKey(deviceId) : gmbStimLockKey(deviceId);
  const ttl = platform === 'instagram' ? STIM_IG_LOCK_TTL_SEC : STIM_GMB_LOCK_TTL_SEC;
  try {
    await redis.getClient().set(key, '1', { EX: ttl });
  } catch {
    /* best-effort */
  }
}

async function refreshStimLock(
  redis: RedisService | null,
  platform: StimulatePlatform,
  deviceId: string
): Promise<void> {
  if (!redis?.isRedisConnected()) return;
  const key = platform === 'instagram' ? igStimLockKey(deviceId) : gmbStimLockKey(deviceId);
  const ttl = platform === 'instagram' ? STIM_IG_LOCK_TTL_SEC : STIM_GMB_LOCK_TTL_SEC;
  try {
    await redis.getClient().expire(key, ttl);
  } catch {
    /* ok */
  }
}

export class StimulateService {
  private loops: LoopState[] = [];
  private running = false;

  getRunning(): boolean {
    return this.running;
  }

  /**
   * Start per-device/platform publish loops. No-op if STIMULATE_DEVICE empty.
   * If STIMULATE_CLEAR=1, releases locks + caches and does not start loops.
   */
  async start(
    mqttClient: MqttClientManager,
    redis: RedisService | null,
    topicRoot: string,
    mqttPublishEnabled: boolean
  ): Promise<void> {
    if (this.running) {
      logger.warn('[STIM] Already running — skip start');
      return;
    }

    const devices = parseStimulateAllowlist();
    if (devices.length === 0) {
      logger.info('[STIM] STIMULATE_DEVICE unset — stimulate service idle');
      return;
    }

    const platforms = parsePlatforms();
    if (platforms.length === 0) {
      logger.warn('[STIM] No valid STIMULATE_PLATFORMS — idle');
      return;
    }

    const step = parseStep();
    const intervalMs = parseIntervalMs();
    const igTarget = parseIgTarget();
    const gmbTarget = parseGmbTarget();
    const clear = process.env.STIMULATE_CLEAR === '1';

    logger.info('[STIM] ===== Starting in-process stimulate service =====', {
      devices,
      platforms,
      step,
      intervalMs,
      igTarget,
      gmbTarget,
      clear
    });

    if (clear) {
      for (const d of devices) {
        for (const p of platforms) {
          const key = p === 'instagram' ? igStimLockKey(d) : gmbStimLockKey(d);
          try {
            if (redis?.isRedisConnected()) await redis.getClient().del(key);
          } catch {
            /* ok */
          }
          clearStimCache(p, d);
        }
      }
      logger.info('[STIM] STIMULATE_CLEAR=1 — locks/caches cleared; loops not started');
      return;
    }

    const lockRefreshMs = Math.max(60_000, Math.floor(intervalMs * 0.8));

    for (const deviceId of devices) {
      for (const platform of platforms) {
        const cache = readStimCache(platform, deviceId);
        if (cache?.status === 'done') {
          logger.info('[STIM] Skipping already-done (set STIMULATE_CLEAR=1 to reset)', {
            deviceId,
            platform
          });
          await takeStimLock(redis, platform, deviceId);
          continue;
        }

        await takeStimLock(redis, platform, deviceId);

        const loop: LoopState = {
          deviceId,
          platform,
          timer: null,
          lockRefreshTimer: null,
          done: false
        };
        this.loops.push(loop);

        const tick = async (): Promise<void> => {
          if (loop.done) return;
          let done = false;
          try {
            if (platform === 'instagram') {
              if (!redis) {
                logger.warn('[STIM] Redis required for IG ticks — skip', { deviceId });
                return;
              }
              const r = await runIgTick(deviceId, topicRoot, mqttClient, step, igTarget, redis);
              done = r.done;
            } else {
              if (!redis) {
                logger.warn('[STIM] Redis required for GMB ticks — skip', { deviceId });
                return;
              }
              const r = await runGmbTick(
                deviceId,
                topicRoot,
                mqttClient,
                mqttPublishEnabled,
                step,
                gmbTarget,
                redis
              );
              done = r.done;
            }
          } catch (err: unknown) {
            logger.error('[STIM] Tick error', {
              deviceId,
              platform,
              error: err instanceof Error ? err.message : String(err)
            });
          }

          if (done) {
            loop.done = true;
            if (loop.timer) clearInterval(loop.timer);
            loop.timer = null;
            if (loop.lockRefreshTimer) clearInterval(loop.lockRefreshTimer);
            loop.lockRefreshTimer = null;
            // Keep lock so live paths stay skipped until STIMULATE_CLEAR=1
            await takeStimLock(redis, platform, deviceId);
            logger.info('[STIM] Loop complete (lock retained)', { deviceId, platform });
          }
        };

        void tick();
        loop.timer = setInterval(() => void tick(), intervalMs);
        loop.lockRefreshTimer = setInterval(() => {
          if (loop.done) return;
          void refreshStimLock(redis, platform, deviceId);
        }, lockRefreshMs);
      }
    }

    this.running = this.loops.length > 0;
    logger.info('[STIM] In-process loops started', { count: this.loops.length });
  }

  async stop(): Promise<void> {
    if (!this.running && this.loops.length === 0) return;
    logger.info('[STIM] Stopping in-process stimulate service...');
    for (const l of this.loops) {
      if (l.timer) clearInterval(l.timer);
      if (l.lockRefreshTimer) clearInterval(l.lockRefreshTimer);
      const cache = readStimCache(l.platform, l.deviceId);
      if (cache) writeStimCache(l.platform, l.deviceId, cache);
    }
    this.loops = [];
    this.running = false;
    logger.info('[STIM] Stopped (locks retained for crash-safe skip)');
  }
}
