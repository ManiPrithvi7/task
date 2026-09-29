/**
 * Dedicated stim device cache — Redis + local file + in-memory.
 * Completely separate from proof.mqtt:device:{id} / igDeviceRuntimeCache.
 */
import * as fs from 'fs';
import * as path from 'path';
import { REDIS_KEYS } from '../src/constants/redisKeys';
import { getRedisService } from '../src/services/redisService';
import { logger } from '../src/utils/logger';
import { parseStimulateAllowlist } from '../src/utils/stimulateAllowlist';

export type StimDataOrigin = 'stim' | 'social' | 'webhook';

export interface StimDeviceRecord {
  deviceId: string;
  igFollowerCount?: number;
  gmbReviewCount?: number;
  igFollowersOrigin?: StimDataOrigin;
  gmbReviewsOrigin?: StimDataOrigin;
  updatedAt: number;
}

const STIM_HASH_TTL_SEC = 7 * 24 * 3600;

const memory = new Map<string, StimDeviceRecord>();

type LocalFileShape = {
  version: 1;
  updatedAt: string;
  devices: Record<string, StimDeviceRecord>;
};

function dataDir(): string {
  return path.resolve(process.env.DATA_DIR || './data');
}

function localFilePath(): string {
  return path.join(dataDir(), 'stim-cache.json');
}

function emptyLocal(): LocalFileShape {
  return { version: 1, updatedAt: new Date().toISOString(), devices: {} };
}

async function readLocalFile(): Promise<LocalFileShape> {
  try {
    await fs.promises.mkdir(dataDir(), { recursive: true });
    const filePath = localFilePath();
    if (!fs.existsSync(filePath)) return emptyLocal();
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LocalFileShape>;
    return {
      version: 1,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      devices: parsed.devices || {}
    };
  } catch (err: unknown) {
    logger.warn('[STIM_CACHE] failed to read local stim-cache.json', {
      error: err instanceof Error ? err.message : String(err)
    });
    return emptyLocal();
  }
}

async function writeLocalFile(data: LocalFileShape): Promise<void> {
  try {
    await fs.promises.mkdir(dataDir(), { recursive: true });
    const filePath = localFilePath();
    const tmp = `${filePath}.tmp`;
    data.updatedAt = new Date().toISOString();
    await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.promises.rename(tmp, filePath);
  } catch (err: unknown) {
    logger.warn('[STIM_CACHE] failed to write local stim-cache.json', {
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

function recordFromHash(deviceId: string, hash: Record<string, string>): StimDeviceRecord {
  const rec: StimDeviceRecord = { deviceId, updatedAt: Date.now() };
  if (hash.ig_follower_count !== undefined && hash.ig_follower_count !== '') {
    const n = parseInt(hash.ig_follower_count, 10);
    if (!Number.isNaN(n)) rec.igFollowerCount = n;
  }
  if (hash.gmb_review_count !== undefined && hash.gmb_review_count !== '') {
    const n = parseInt(hash.gmb_review_count, 10);
    if (!Number.isNaN(n)) rec.gmbReviewCount = n;
  }
  if (hash.ig_followers_origin === 'stim' || hash.ig_followers_origin === 'social' || hash.ig_followers_origin === 'webhook') {
    rec.igFollowersOrigin = hash.ig_followers_origin;
  }
  if (hash.gmb_reviews_origin === 'stim' || hash.gmb_reviews_origin === 'social' || hash.gmb_reviews_origin === 'webhook') {
    rec.gmbReviewsOrigin = hash.gmb_reviews_origin;
  }
  if (hash.updated_at) {
    const n = parseInt(hash.updated_at, 10);
    if (!Number.isNaN(n)) rec.updatedAt = n;
  }
  return rec;
}

function hashFromRecord(rec: StimDeviceRecord): Record<string, string> {
  const out: Record<string, string> = { updated_at: String(rec.updatedAt) };
  if (rec.igFollowerCount !== undefined) out.ig_follower_count = String(rec.igFollowerCount);
  if (rec.gmbReviewCount !== undefined) out.gmb_review_count = String(rec.gmbReviewCount);
  if (rec.igFollowersOrigin) out.ig_followers_origin = rec.igFollowersOrigin;
  if (rec.gmbReviewsOrigin) out.gmb_reviews_origin = rec.gmbReviewsOrigin;
  return out;
}

export function logStimCacheActive(): void {
  const devices = parseStimulateAllowlist();
  if (devices.length === 0) return;
  logger.info('[STIM_CACHE] active with device list', { devices });
}

/** In-memory get (sync). */
export function get(deviceId: string): StimDeviceRecord | undefined {
  return memory.get(deviceId);
}

export function getFollowers(deviceId: string): number | undefined {
  return memory.get(deviceId)?.igFollowerCount;
}

export function getGmbReviewCount(deviceId: string): number | undefined {
  return memory.get(deviceId)?.gmbReviewCount;
}

export type StimSetPatch = {
  igFollowerCount?: number;
  gmbReviewCount?: number;
  igFollowersOrigin?: StimDataOrigin;
  gmbReviewsOrigin?: StimDataOrigin;
};

/** Merge patch into memory + local + Redis stim namespace. */
export async function set(deviceId: string, patch: StimSetPatch): Promise<StimDeviceRecord> {
  const prev = memory.get(deviceId) ?? { deviceId, updatedAt: Date.now() };
  const next: StimDeviceRecord = {
    ...prev,
    deviceId,
    updatedAt: Date.now()
  };
  if (patch.igFollowerCount !== undefined) {
    next.igFollowerCount = patch.igFollowerCount;
    next.igFollowersOrigin = patch.igFollowersOrigin ?? 'stim';
  }
  if (patch.gmbReviewCount !== undefined) {
    next.gmbReviewCount = patch.gmbReviewCount;
    next.gmbReviewsOrigin = patch.gmbReviewsOrigin ?? 'stim';
  }
  if (patch.igFollowersOrigin !== undefined && patch.igFollowerCount === undefined) {
    next.igFollowersOrigin = patch.igFollowersOrigin;
  }
  if (patch.gmbReviewsOrigin !== undefined && patch.gmbReviewCount === undefined) {
    next.gmbReviewsOrigin = patch.gmbReviewsOrigin;
  }

  memory.set(deviceId, next);

  const local = await readLocalFile();
  local.devices[deviceId] = next;
  await writeLocalFile(local);

  const redisSvc = getRedisService();
  if (redisSvc?.isRedisConnected()) {
    try {
      const client = redisSvc.getClient();
      const key = REDIS_KEYS.stimDeviceHash(deviceId);
      await client.hSet(key, hashFromRecord(next));
      await client.expire(key, STIM_HASH_TTL_SEC);
      await client.sAdd(REDIS_KEYS.stimActiveDevices, deviceId);
    } catch (err: unknown) {
      logger.warn('[STIM_CACHE] Redis set failed', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return next;
}

export async function del(deviceId: string): Promise<void> {
  memory.delete(deviceId);
  const local = await readLocalFile();
  if (local.devices[deviceId]) {
    delete local.devices[deviceId];
    await writeLocalFile(local);
  }
  const redisSvc = getRedisService();
  if (redisSvc?.isRedisConnected()) {
    try {
      const client = redisSvc.getClient();
      await client.del(REDIS_KEYS.stimDeviceHash(deviceId));
      await client.sRem(REDIS_KEYS.stimActiveDevices, deviceId);
    } catch (err: unknown) {
      logger.warn('[STIM_CACHE] Redis del failed', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
}

/** Clear in-memory only (cursor companion). */
export function clearMemory(): void {
  memory.clear();
}

/**
 * Purge stim Redis keys + local file + memory.
 * When `onlyDeviceIds` is set, only those IDs are removed; otherwise wipe all.
 */
export async function purgeAll(onlyDeviceIds?: ReadonlySet<string> | string[]): Promise<{
  redis: number;
  local: number;
}> {
  const filter =
    onlyDeviceIds == null
      ? null
      : onlyDeviceIds instanceof Set
        ? onlyDeviceIds
        : new Set(onlyDeviceIds);

  let redisCount = 0;
  let localCount = 0;

  const local = await readLocalFile();
  const localIds = Object.keys(local.devices);
  for (const id of localIds) {
    if (filter && !filter.has(id)) continue;
    delete local.devices[id];
    localCount += 1;
    memory.delete(id);
  }
  if (localCount > 0 || filter == null) {
    if (filter == null) {
      for (const id of [...memory.keys()]) memory.delete(id);
      local.devices = {};
      localCount = Math.max(localCount, localIds.length);
    }
    await writeLocalFile(local);
  } else {
    for (const id of [...memory.keys()]) {
      if (!filter || filter.has(id)) memory.delete(id);
    }
  }

  const redisSvc = getRedisService();
  if (redisSvc?.isRedisConnected()) {
    try {
      const client = redisSvc.getClient();
      let members: string[] = [];
      try {
        members = await client.sMembers(REDIS_KEYS.stimActiveDevices);
      } catch {
        members = [];
      }

      // Also SCAN orphaned stim hashes not listed in the active set
      try {
        for await (const key of client.scanIterator({ MATCH: 'proof.mqtt:stim:device:*', COUNT: 100 })) {
          const keys = Array.isArray(key) ? key : [key];
          for (const k of keys) {
            const id = String(k).replace(/^proof\.mqtt:stim:device:/, '');
            if (id) members.push(id);
          }
        }
      } catch {
        /* best-effort SCAN */
      }

      const unique = [...new Set(members)];
      const toRemove = filter ? unique.filter((id) => filter.has(id)) : unique;
      for (const id of toRemove) {
        const deleted = await client.del(REDIS_KEYS.stimDeviceHash(id));
        redisCount += deleted > 0 ? 1 : 0;
        await client.sRem(REDIS_KEYS.stimActiveDevices, id);
      }
      if (filter == null) {
        // Wipe stim set + any leftover stim:* keys (offers/lab keys are ota:stim under proof-mqtt: prefix)
        await client.del(REDIS_KEYS.stimActiveDevices);
        try {
          for await (const key of client.scanIterator({ MATCH: 'proof.mqtt:stim:*', COUNT: 100 })) {
            const keys = Array.isArray(key) ? key : [key];
            for (const k of keys) {
              const deleted = await client.del(String(k));
              if (deleted > 0) redisCount += 1;
            }
          }
        } catch {
          /* best-effort */
        }
      }
    } catch (err: unknown) {
      logger.warn('[STIM_CACHE] Redis purge failed', {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  logger.info('[STIM_CACHE] purged stim entries', { redis: redisCount, local: localCount });
  return { redis: redisCount, local: localCount };
}

export async function clearAll(): Promise<{ redis: number; local: number }> {
  return purgeAll();
}

export async function listActive(): Promise<string[]> {
  const ids = new Set<string>([...memory.keys()]);
  const local = await readLocalFile();
  for (const id of Object.keys(local.devices)) ids.add(id);

  const redisSvc = getRedisService();
  if (redisSvc?.isRedisConnected()) {
    try {
      const members = await redisSvc.getClient().sMembers(REDIS_KEYS.stimActiveDevices);
      for (const id of members) ids.add(id);
    } catch {
      /* best-effort */
    }
  }
  return [...ids];
}

/** Hydrate memory from Redis stim hash, else local file. */
export async function hydrate(deviceId: string): Promise<StimDeviceRecord | undefined> {
  const redisSvc = getRedisService();
  if (redisSvc?.isRedisConnected()) {
    try {
      const hash = await redisSvc.getClient().hGetAll(REDIS_KEYS.stimDeviceHash(deviceId));
      if (hash && Object.keys(hash).length > 0) {
        const rec = recordFromHash(deviceId, hash);
        memory.set(deviceId, rec);
        return rec;
      }
    } catch {
      /* fall through */
    }
  }

  const local = await readLocalFile();
  const rec = local.devices[deviceId];
  if (rec) {
    memory.set(deviceId, rec);
    return rec;
  }
  return memory.get(deviceId);
}

/** Reset helpers for unit tests. */
export function _resetForTests(): void {
  memory.clear();
}
