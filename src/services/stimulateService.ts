/**
 * TEMP STIMULATE — remove after testing
 * In-process stimulate loops for allowlisted devices (no separate process).
 * In-memory cursor + device runtime/Redis hash (`ig_follower_count` / `gmb_review_count`).
 */
import type { RedisClientType } from 'redis';
import type { MqttClientManager } from '../servers/mqttClient';
import type { RedisService } from './redisService';
import type { IFirmwareStorage } from './firmwareStorageService';
import { parseStimTestOtaEnvSeed } from '../config/envHelpers';
import { logger } from '../utils/logger';
import { parseStimulateAllowlist, isStimulateDevice } from '../utils/stimulateAllowlist';
import {
  generateStimLabKeypair,
  isProductionNodeEnv,
  signAndVerifyFirmwareBytes,
  type StimLabKeypair
} from '../utils/stimOtaCrypto';
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
  firmwareStorage?: IFirmwareStorage | null;
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
    mqttPublishEnabled: boolean,
    firmwareStorage?: IFirmwareStorage | null
  ): Promise<void> {
    if (this.running) {
      logger.warn('[STIM] Already running — skip start');
      return;
    }

    this.deps = { mqttClient, redis, topicRoot, mqttPublishEnabled, firmwareStorage: firmwareStorage ?? null };

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

    await this.publishTestOtaOnConnect(deviceId);
  }

  /** One-shot production-shaped ota_update. Version/sha256/signature/size come from Redis only. */
  private async publishTestOtaOnConnect(deviceId: string): Promise<void> {
    if (!isStimulateDevice(deviceId) || !this.deps) return;

    if (!this.deps.mqttPublishEnabled) {
      logger.warn('[STIM-OTA] MQTT publish disabled — skip', { deviceId });
      return;
    }

    let offer: {
      downloadUrl: string;
      version: string;
      sha256: string;
      signature: string;
      sizeBytes: number;
    } | null = null;

    try {
      const redisOffer = await loadStimOtaOffer(this.deps.redis);
      if (!redisOffer) {
        return;
      }
      let downloadUrl = '';
      if (redisOffer.objectKey && this.deps.firmwareStorage) {
        downloadUrl = await this.deps.firmwareStorage.createPresignedGetUrl(
          redisOffer.objectKey,
          redisOffer.version
        );
      } else if (redisOffer.downloadUrl) {
        downloadUrl = redisOffer.downloadUrl;
      } else {
        logger.warn('[STIM-OTA] Redis offer missing download_url and OCI object — skip', {
          deviceId
        });
        return;
      }
      offer = {
        downloadUrl,
        version: redisOffer.version,
        sha256: redisOffer.sha256,
        signature: redisOffer.signature,
        sizeBytes: redisOffer.sizeBytes
      };
    } catch (err: unknown) {
      logger.warn('[STIM-OTA] Offer resolve failed — skip', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
      return;
    }
    if (!offer) return;

    let urlHost = offer.downloadUrl;
    try {
      urlHost = new URL(offer.downloadUrl).host;
    } catch {
      /* keep raw */
    }

    const payload = {
      cmd: 'ota_update',
      track: 'pilot',
      version: offer.version,
      download_url: offer.downloadUrl,
      sha256: offer.sha256,
      signature: offer.signature,
      size_bytes: offer.sizeBytes,
      force: false,
      issued_at: new Date().toISOString()
    };
    const topic = `${this.deps.topicRoot}/${deviceId}/cmd`;

    try {
      await this.deps.mqttClient.publish({
        topic,
        payload: JSON.stringify(payload),
        qos: 2,
        retain: false
      });
      logger.info('[STIM-OTA] Published ota_update', {
        deviceId,
        version: offer.version,
        sizeBytes: offer.sizeBytes,
        downloadHost: urlHost,
        topic
      });
    } catch (err: unknown) {
      logger.warn('[STIM-OTA] Publish failed', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
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

export const STIM_OTA_OBJECT_KEY = 'firmware/stim/firmware.bin';

export type StimOtaRedisOffer = {
  version: string;
  sha256: string;
  signature: string;
  sizeBytes: number;
  objectKey: string;
  downloadUrl: string;
  filename: string;
  updatedAt: string;
};

function redisClient(redis: RedisService | null): RedisClientType | null {
  if (!redis?.isRedisConnected()) return null;
  try {
    return redis.getClient();
  } catch {
    return null;
  }
}

export async function getOrCreateStimLabKeypair(redis: RedisService | null): Promise<StimLabKeypair> {
  if (isProductionNodeEnv()) {
    throw new Error('Stim lab Ed25519 keypair is not allowed when NODE_ENV=production');
  }
  const client = redisClient(redis);
  if (!client) {
    throw new Error('Redis is required to store stim lab Ed25519 keys');
  }

  const key = REDIS_KEYS.otaStimLabKeypair;
  const existing = await client.hGetAll(key);
  if (existing.private_pem?.includes('BEGIN') && existing.public_pem?.includes('BEGIN')) {
    return { privatePem: existing.private_pem, publicPem: existing.public_pem };
  }

  const locked = await client.set(REDIS_KEYS.otaStimLabKeypairLock, '1', { NX: true, EX: 30 });
  const retry = await client.hGetAll(key);
  if (retry.private_pem?.includes('BEGIN') && retry.public_pem?.includes('BEGIN')) {
    return { privatePem: retry.private_pem, publicPem: retry.public_pem };
  }

  if (!locked) {
    await new Promise((r) => setTimeout(r, 50));
    const after = await client.hGetAll(key);
    if (after.private_pem?.includes('BEGIN') && after.public_pem?.includes('BEGIN')) {
      return { privatePem: after.private_pem, publicPem: after.public_pem };
    }
    throw new Error('Stim lab keypair lock held but no PEM in Redis');
  }

  const pair = generateStimLabKeypair();
  await client.hSet(key, {
    private_pem: pair.privatePem,
    public_pem: pair.publicPem,
    created_at: new Date().toISOString()
  });
  logger.info('[STIM-OTA] Generated lab Ed25519 keypair in Redis');
  return pair;
}

export async function loadStimLabPublicPem(redis: RedisService | null): Promise<string | null> {
  try {
    const pair = await getOrCreateStimLabKeypair(redis);
    return pair.publicPem;
  } catch (err: unknown) {
    logger.warn('[STIM-OTA] Lab public key unavailable', {
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

export async function loadStimOtaOffer(redis: RedisService | null): Promise<StimOtaRedisOffer | null> {
  const client = redisClient(redis);
  if (!client) return null;
  const hash = await client.hGetAll(REDIS_KEYS.otaStimOffer);
  const version = hash.version?.trim();
  const sha256 = hash.sha256?.trim().toLowerCase();
  const signature = hash.signature?.trim();
  const objectKey = hash.object_key?.trim() || '';
  const downloadUrl = hash.download_url?.trim() || '';
  const sizeBytes = hash.size_bytes ? Number.parseInt(hash.size_bytes, 10) : NaN;
  if (!version || !sha256 || !signature || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return null;
  }
  if (!objectKey && !downloadUrl) {
    return null;
  }
  return {
    version,
    sha256,
    signature,
    sizeBytes,
    objectKey,
    downloadUrl,
    filename: hash.filename?.trim() || 'firmware.bin',
    updatedAt: hash.updated_at || ''
  };
}

export async function saveStimOtaOffer(
  redis: RedisService | null,
  offer: StimOtaRedisOffer
): Promise<void> {
  const client = redisClient(redis);
  if (!client) {
    throw new Error('Redis is required to store stim OTA offer');
  }
  await client.hSet(REDIS_KEYS.otaStimOffer, {
    version: offer.version,
    sha256: offer.sha256,
    signature: offer.signature,
    size_bytes: String(offer.sizeBytes),
    object_key: offer.objectKey,
    download_url: offer.downloadUrl,
    filename: offer.filename,
    updated_at: offer.updatedAt
  });
}

/** Copy TEST_OTA_VERSION/SHA256/SIGNATURE/SIZE_BYTES (+ optional URL) into Redis. MQTT reads Redis only. */
export async function seedStimOtaOfferFromEnv(redis: RedisService | null): Promise<boolean> {
  if (isProductionNodeEnv()) return false;
  const seed = parseStimTestOtaEnvSeed();
  if (!seed) return false;
  const existing = await loadStimOtaOffer(redis);
  const downloadUrl = seed.downloadUrl || existing?.downloadUrl || '';
  const objectKey = seed.downloadUrl ? '' : existing?.objectKey || '';
  if (!downloadUrl && !objectKey) {
    logger.warn('[STIM-OTA] Env metadata present but no TEST_OTA_URL or Redis object_key — skip seed');
    return false;
  }
  await saveStimOtaOffer(redis, {
    version: seed.version,
    sha256: seed.sha256,
    signature: seed.signature,
    sizeBytes: seed.sizeBytes,
    objectKey,
    downloadUrl,
    filename: existing?.filename || 'firmware.bin',
    updatedAt: new Date().toISOString()
  });
  logger.info('[STIM-OTA] Seeded Redis offer from TEST_OTA_* env', {
    version: seed.version,
    sizeBytes: seed.sizeBytes,
    hasDownloadUrl: Boolean(downloadUrl),
    hasObjectKey: Boolean(objectKey)
  });
  return true;
}

export async function hasStimRedisOffer(redis: RedisService | null): Promise<boolean> {
  return Boolean(await loadStimOtaOffer(redis));
}

const STIM_OTA_MAX_BYTES = 2 * 1024 * 1024;

export async function replaceStimFirmware(input: {
  redis: RedisService | null;
  storage: IFirmwareStorage;
  version: string;
  bytes: Buffer;
  filename: string;
}): Promise<StimOtaRedisOffer> {
  if (isProductionNodeEnv()) {
    throw new Error('Stim firmware upload is not allowed when NODE_ENV=production');
  }
  const version = input.version.trim();
  if (!version) {
    throw new Error('version is required');
  }
  if (!input.bytes.length) {
    throw new Error('firmware file is empty');
  }
  if (input.bytes.length > STIM_OTA_MAX_BYTES) {
    throw new Error(`Firmware size ${input.bytes.length} exceeds maximum ${STIM_OTA_MAX_BYTES}`);
  }

  const previous = await loadStimOtaOffer(input.redis);
  const objectKey = STIM_OTA_OBJECT_KEY;
  const toDelete = new Set<string>([objectKey]);
  if (previous?.objectKey) toDelete.add(previous.objectKey);
  for (const key of toDelete) {
    await input.storage.deleteObject(key);
  }

  const keypair = await getOrCreateStimLabKeypair(input.redis);
  const { sha256, signature } = signAndVerifyFirmwareBytes(input.bytes, keypair);
  await input.storage.putObject(objectKey, input.bytes, { version, sha256 });

  const offer: StimOtaRedisOffer = {
    version,
    sha256,
    signature,
    sizeBytes: input.bytes.length,
    objectKey,
    downloadUrl: previous?.downloadUrl || '',
    filename: input.filename.trim() || 'firmware.bin',
    updatedAt: new Date().toISOString()
  };
  await saveStimOtaOffer(input.redis, offer);
  logger.info('[STIM-OTA] Stim firmware replaced', {
    version,
    sha256,
    sizeBytes: offer.sizeBytes,
    objectKey
  });
  return offer;
}
