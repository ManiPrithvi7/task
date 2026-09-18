/**
 * TEMP STIMULATE — remove after testing
 * In-process stimulate loops for allowlisted devices (no separate process).
 * In-memory cursor + device runtime/Redis hash (`ig_follower_count` / `gmb_review_count`).
 */
import type { MqttClientManager } from '../servers/mqttClient';
import type { RedisService } from './redisService';
import { logger } from '../utils/logger';
import { parseStimulateAllowlist, isStimulateDevice } from '../utils/stimulateAllowlist';
import { runIgTick, STIM_IG_LOCK_TTL_SEC } from '../../stimulate/igRunner';
import { runGmbTick, STIM_GMB_LOCK_TTL_SEC } from '../../stimulate/gmbRunner';
import {
  clearStimCache,
  clearDeviceStimCache,
  clearAllStimCache,
  readStimCache,
  writeStimCache
} from '../../stimulate/cache';
import { getActiveDeviceCache } from './deviceService';
import { getLocalStimLock } from './localCaches';
import { getIgDeviceRuntimeCache } from './igDeviceRuntimeCache';
import { REDIS_KEYS } from '../constants/redisKeys';

export type StimulatePlatform = 'instagram' | 'gmb';

function stimLockType(platform: StimulatePlatform): 'ig' | 'gmb' {
  return platform === 'instagram' ? 'ig' : 'gmb';
}

type LoopState = {
  deviceId: string;
  platform: StimulatePlatform;
  timer: ReturnType<typeof setInterval> | null;
  lockRefreshTimer: ReturnType<typeof setInterval> | null;
  done: boolean;
};

type StartDeps = {
  mqttClient: MqttClientManager;
  redis: RedisService | null;
  topicRoot: string;
  mqttPublishEnabled: boolean;
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
  return Math.max(1, parseInt(process.env.STIMULATE_IG_TARGET || '5000', 10) || 5000);
}

function parseGmbTarget(): number {
  return Math.max(1, parseInt(process.env.STIMULATE_GMB_TARGET || '5000', 10) || 5000);
}

async function takeStimLock(
  _redis: RedisService | null,
  platform: StimulatePlatform,
  deviceId: string
): Promise<void> {
  const ttl = platform === 'instagram' ? STIM_IG_LOCK_TTL_SEC : STIM_GMB_LOCK_TTL_SEC;
  const lock = getLocalStimLock();
  const type = stimLockType(platform);
  // Force acquire (same as Redis SET overwrite).
  lock.release(deviceId, type);
  lock.tryAcquire(deviceId, type, ttl * 1000);
}

async function refreshStimLock(
  _redis: RedisService | null,
  platform: StimulatePlatform,
  deviceId: string
): Promise<void> {
  const ttl = platform === 'instagram' ? STIM_IG_LOCK_TTL_SEC : STIM_GMB_LOCK_TTL_SEC;
  getLocalStimLock().refresh(deviceId, stimLockType(platform), ttl * 1000);
}

export class StimulateService {
  private loops: LoopState[] = [];
  private running = false;
  private deps: StartDeps | null = null;

  getRunning(): boolean {
    return this.running;
  }

  /**
   * Start per-device/platform publish loops. No-op if STIMULATE_DEVICE empty.
   * Resumes from in-memory cursor or Redis device hash when present.
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

    this.deps = { mqttClient, redis, topicRoot, mqttPublishEnabled };

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

    const forceReset = process.env.STIMULATE_CLEAR === '1';
    if (forceReset) {
      clearAllStimCache();
      const runtime = getIgDeviceRuntimeCache();
      for (const d of devices) {
        getLocalStimLock().releaseAll(d);
        runtime.setFollowers(d, 0);
        runtime.setGmbReviewCount(d, 0);
      }
      logger.info('[STIM] STIMULATE_CLEAR=1 — stim cursor reset (will not resume Redis counts)');
    }

    const step = parseStep();
    const intervalMs = parseIntervalMs();
    const igTarget = parseIgTarget();
    const gmbTarget = parseGmbTarget();

    if (!forceReset) {
      await this.seedProgressFromExistingCache(devices, igTarget, gmbTarget);
    }

    logger.info('[STIM] ===== Starting in-process stimulate service =====', {
      devices,
      platforms,
      step,
      intervalMs,
      igTarget,
      gmbTarget,
      progress: forceReset ? 'forced reset' : 'resume from memory or Redis device hash',
    });

    await this.spawnLoops(devices, platforms, step, intervalMs, igTarget, gmbTarget, forceReset);
    this.running = this.loops.length > 0;
    logger.info('[STIM] In-process loops started', { count: this.loops.length });
  }

  /**
   * Device disconnect (LWT) → stop loops and let cache TTL expire naturally.
   */
  async stopOnDeviceDisconnect(deviceId: string): Promise<void> {
    if (!isStimulateDevice(deviceId)) return;
    logger.info('[STIM] /lwt — device disconnected, stopping loops (cache preserved with TTL)', {
      deviceId,
    });
    this.stopLoopsForDevice(deviceId);
    getLocalStimLock().releaseAll(deviceId);
  }

  /**
   * Device /active on an allowlisted id:
   *  - If last published exists (memory or Redis hash) → resume.
   *  - Else → start ramp from scratch.
   */
  async resetOnDeviceConnect(deviceId: string): Promise<void> {
    if (!isStimulateDevice(deviceId) || !this.deps) return;

    this.stopLoopsForDevice(deviceId);

    const platforms = parsePlatforms();
    const step = parseStep();
    const intervalMs = parseIntervalMs();
    const igTarget = parseIgTarget();
    const gmbTarget = parseGmbTarget();

    await this.seedProgressFromExistingCache([deviceId], igTarget, gmbTarget);

    const igCache = readStimCache('instagram', deviceId);
    const gmbCache = readStimCache('gmb', deviceId);
    const hasValidCache = Boolean(igCache || gmbCache);

    if (hasValidCache) {
      logger.info('[STIM] /active — cache valid, resuming ramp', {
        deviceId,
        ig: igCache?.lastPublished,
        gmb: gmbCache?.lastPublished
      });
      await this.spawnLoops([deviceId], platforms, step, intervalMs, igTarget, gmbTarget, false);
    } else {
      logger.info('[STIM] /active — no last-published cache, resetting ramp from scratch', {
        deviceId,
      });
      clearDeviceStimCache(deviceId);
      await this.spawnLoops([deviceId], platforms, step, intervalMs, igTarget, gmbTarget, true);
    }
    this.running = this.loops.length > 0;
  }

  /** Hydrate in-memory stim cursor from runtime cache / Redis device hash. */
  private async seedProgressFromExistingCache(
    devices: string[],
    igTarget: number,
    gmbTarget: number
  ): Promise<void> {
    const runtime = getIgDeviceRuntimeCache();
    const redis = this.deps?.redis ?? null;

    for (const deviceId of devices) {
      if (
        (runtime.getFollowers(deviceId) == null || runtime.getGmbReviewCount(deviceId) == null) &&
        redis?.isRedisConnected()
      ) {
        try {
          const hash = await redis.getClient().hGetAll(REDIS_KEYS.deviceHash(deviceId));
          if (hash && Object.keys(hash).length > 0) {
            runtime.hydrateFromHashFields(deviceId, hash);
          }
        } catch (err: unknown) {
          logger.debug('[STIM] Redis hash hydrate skipped', {
            deviceId,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }

      if (!readStimCache('instagram', deviceId)) {
        const ig = runtime.getFollowers(deviceId);
        if (ig != null && ig > 0) {
          writeStimCache('instagram', deviceId, {
            lastPublished: ig,
            status: ig >= igTarget ? 'done' : 'running'
          });
        }
      }
      if (!readStimCache('gmb', deviceId)) {
        const gmb = runtime.getGmbReviewCount(deviceId);
        if (gmb != null && gmb > 0) {
          writeStimCache('gmb', deviceId, {
            lastPublished: gmb,
            status: gmb >= gmbTarget ? 'done' : 'running'
          });
        }
      }
    }
  }

  private stopLoopsForDevice(deviceId: string): void {
    const keep: LoopState[] = [];
    for (const l of this.loops) {
      if (l.deviceId !== deviceId) {
        keep.push(l);
        continue;
      }
      if (l.timer) clearInterval(l.timer);
      if (l.lockRefreshTimer) clearInterval(l.lockRefreshTimer);
    }
    this.loops = keep;
  }

  private async spawnLoops(
    devices: string[],
    platforms: StimulatePlatform[],
    step: number,
    intervalMs: number,
    igTarget: number,
    gmbTarget: number,
    clearCache = true
  ): Promise<void> {
    const deps = this.deps;
    if (!deps) return;

    const { mqttClient, redis, topicRoot, mqttPublishEnabled } = deps;
    const lockRefreshMs = Math.max(60_000, Math.floor(intervalMs * 0.8));

    for (const deviceId of devices) {
      for (const platform of platforms) {
        if (clearCache) clearStimCache(platform, deviceId);
        await takeStimLock(redis, platform, deviceId);

        const loop: LoopState = {
          deviceId,
          platform,
          timer: null,
          lockRefreshTimer: null,
          done: false,
        };
        this.loops.push(loop);

        const tick = async (): Promise<void> => {
          if (loop.done) return;
          let done = false;
          try {
            const active = await getActiveDeviceCache().getActive(deviceId);
            if (!active) {
              logger.debug('[STIM] Device not active — skip tick', { deviceId, platform });
              return;
            }
            if (platform === 'instagram') {
              const r = await runIgTick(deviceId, topicRoot, mqttClient, step, igTarget, redis);
              done = r.done;
            } else {
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
              error: err instanceof Error ? err.message : String(err),
            });
          }

          if (done) {
            loop.done = true;
            if (loop.timer) clearInterval(loop.timer);
            loop.timer = null;
            if (loop.lockRefreshTimer) clearInterval(loop.lockRefreshTimer);
            loop.lockRefreshTimer = null;
            await takeStimLock(redis, platform, deviceId);
            logger.info('[STIM] Loop complete — reconnect device (/active) to restart from 0', {
              deviceId,
              platform,
            });
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
  }

  async stop(): Promise<void> {
    if (!this.running && this.loops.length === 0) return;
    logger.info('[STIM] Stopping in-process stimulate service...');
    const released = new Set<string>();
    for (const l of this.loops) {
      if (l.timer) clearInterval(l.timer);
      if (l.lockRefreshTimer) clearInterval(l.lockRefreshTimer);
      if (!released.has(l.deviceId)) {
        getLocalStimLock().releaseAll(l.deviceId);
        released.add(l.deviceId);
      }
    }
    this.loops = [];
    this.running = false;
    this.deps = null;
    logger.info('[STIM] Stopped');
  }
}
