import type { RedisClientType } from 'redis';
import { REDIS_KEYS } from '../constants/redisKeys';
import { getActiveDeviceCache } from './deviceService';
import { getRedisService } from './redisService';
import { logger } from '../utils/logger';

export interface DeviceRuntimeState {
  igFollowerCount?: number;
  gmbReviewCount?: number;
  lastPubMs?: number;
  powerSave?: boolean;
  dirtyFields: Set<string>;
}

export interface ResolvedDeviceMeta {
  instagramAccountId: string;
  accessToken: string;
  userId?: string;
}


class IgDeviceRuntimeCacheImpl {
  private devices = new Map<string, DeviceRuntimeState>();

  private entry(deviceId: string): DeviceRuntimeState {
    let e = this.devices.get(deviceId);
    if (!e) {
      e = { dirtyFields: new Set() };
      this.devices.set(deviceId, e);
    }
    return e;
  }

  getFollowers(deviceId: string): number | undefined {
    return this.devices.get(deviceId)?.igFollowerCount;
  }

  setFollowers(deviceId: string, count: number): void {
    const e = this.entry(deviceId);
    e.igFollowerCount = count;
  }

  getGmbReviewCount(deviceId: string): number | undefined {
    return this.devices.get(deviceId)?.gmbReviewCount;
  }

  setGmbReviewCount(deviceId: string, count: number): void {
    const e = this.entry(deviceId);
    e.gmbReviewCount = count;
  }

  getLastPub(deviceId: string): number {
    return this.devices.get(deviceId)?.lastPubMs ?? 0;
  }

  setLastPub(deviceId: string, ms: number): void {
    this.entry(deviceId).lastPubMs = ms;
  }

  getPowerSave(deviceId: string): boolean {
    return this.devices.get(deviceId)?.powerSave ?? false;
  }

  setPowerSave(deviceId: string, on: boolean): void {
    this.entry(deviceId).powerSave = on;
  }

  markDirty(deviceId: string, field: string): void {
    this.entry(deviceId).dirtyFields.add(field);
  }

  getDirtyDevices(): Array<[string, DeviceRuntimeState]> {
    return [...this.devices.entries()].filter(([, s]) => s.dirtyFields.size > 0);
  }

  clearDirty(deviceId: string): void {
    this.devices.get(deviceId)?.dirtyFields.clear();
  }

  delete(deviceId: string): void {
    this.devices.delete(deviceId);
  }

  hydrateFromHashFields(
    deviceId: string,
    fields: Record<string, string>
  ): void {
    const e = this.entry(deviceId);
    if (fields.ig_follower_count !== undefined) {
      const n = parseInt(fields.ig_follower_count, 10);
      if (!Number.isNaN(n)) e.igFollowerCount = n;
    }
    if (fields.gmb_review_count !== undefined) {
      const n = parseInt(fields.gmb_review_count, 10);
      if (!Number.isNaN(n)) e.gmbReviewCount = n;
    }
    if (fields.power_save !== undefined) {
      e.powerSave = fields.power_save === '1' || fields.power_save === 'true';
    }
  }

  /** ActiveDevice first, then Redis hash with legacy JSON string fallback. */
  async resolveMeta(deviceId: string): Promise<ResolvedDeviceMeta | null> {
    const local = await getActiveDeviceCache().getActive(deviceId);
    if (local?.instagramAccountId?.trim() && local.accessToken?.trim()) {
      return {
        instagramAccountId: local.instagramAccountId.trim(),
        accessToken: local.accessToken.trim(),
        userId: local.userId?.trim() || undefined
      };
    }

    const redisSvc = getRedisService();
    if (!redisSvc?.isRedisConnected()) return null;

    const key = REDIS_KEYS.deviceHash(deviceId);
    const client = redisSvc.getClient();

    try {
      const hash = await client.hGetAll(key);
      if (Object.keys(hash).length > 0) {
        return parseMetaFromHash(hash, local?.userId);
      }

      const raw = await client.get(key);
      if (!raw) return null;
      const o = JSON.parse(raw) as Record<string, unknown>;
      const instagramAccountId =
        typeof o.instagramAccountId === 'string' ? o.instagramAccountId.trim() : '';
      const accessToken = typeof o.accessToken === 'string' ? o.accessToken.trim() : '';
      if (!instagramAccountId || !accessToken) return null;
      const userId =
        typeof o.userId === 'string'
          ? o.userId.trim()
          : typeof o.user_id === 'string'
            ? o.user_id.trim()
            : local?.userId?.trim();
      return {
        instagramAccountId,
        accessToken,
        ...(userId ? { userId } : {})
      };
    } catch (err: unknown) {
      logger.debug('[IG_RUNTIME_CACHE] resolveMeta failed', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
      return null;
    }
  }
}

function parseMetaFromHash(
  hash: Record<string, string>,
  fallbackUserId?: string
): ResolvedDeviceMeta | null {
  const instagramAccountId =
    (hash.ig_accountId ?? hash.instagramAccountId ?? '').trim();
  const accessToken = (hash.ig_accessToken ?? hash.accessToken ?? '').trim();
  if (!instagramAccountId || !accessToken) return null;
  const userId = (hash.userId ?? fallbackUserId ?? '').trim();
  return {
    instagramAccountId,
    accessToken,
    ...(userId ? { userId } : {})
  };
}

let instance: IgDeviceRuntimeCacheImpl | null = null;

export function getIgDeviceRuntimeCache(): IgDeviceRuntimeCacheImpl {
  if (!instance) instance = new IgDeviceRuntimeCacheImpl();
  return instance;
}

export function resetIgDeviceRuntimeCacheForTests(): void {
  instance = null;
}

/** Load GMB review count from canonical location key into runtime cache. */
export async function hydrateGmbReviewCountFromRedis(
  deviceId: string,
  locationId: string
): Promise<number | undefined> {
  const redisSvc = getRedisService();
  if (!redisSvc?.isRedisConnected() || !locationId.trim()) return undefined;
  try {
    const raw = await redisSvc.getClient().get(REDIS_KEYS.gmbReviews(locationId.trim()));
    if (raw === null) return undefined;
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) return undefined;
    getIgDeviceRuntimeCache().setGmbReviewCount(deviceId, n);
    return n;
  } catch {
    return undefined;
  }
}

/** Write device hash on connect; replaces legacy JSON string key. */
export async function writeDeviceHashOnConnect(
  deviceId: string,
  fields: Record<string, string>
): Promise<void> {
  const redisSvc = getRedisService();
  if (!redisSvc?.isRedisConnected()) return;
  const key = REDIS_KEYS.deviceHash(deviceId);
  const client = redisSvc.getClient();
  const TTL = 7 * 24 * 3600;
  try {
    const keyType = await client.type(key);
    if (keyType === 'string') {
      await client.del(key);
    }
    await client.hSet(key, fields);
    await client.expire(key, TTL);
    getIgDeviceRuntimeCache().hydrateFromHashFields(deviceId, fields);
  } catch (err: unknown) {
    logger.warn('[IG_RUNTIME_CACHE] writeDeviceHashOnConnect failed', {
      deviceId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/** Mark device inactive in hash (disconnect) — do not delete hash. */
export async function markDeviceHashInactive(deviceId: string): Promise<void> {
  const redisSvc = getRedisService();
  if (!redisSvc?.isRedisConnected()) return;
  const key = REDIS_KEYS.deviceHash(deviceId);
  try {
    const client = redisSvc.getClient();
    const keyType = await client.type(key);
    if (keyType === 'hash') {
      await client.hSet(key, 'status', 'inactive');
      await client.expire(key, 7 * 24 * 3600);
    }
  } catch (err: unknown) {
    logger.debug('[IG_RUNTIME_CACHE] markDeviceHashInactive failed', {
      deviceId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  getIgDeviceRuntimeCache().delete(deviceId);
}

/** Read follower count for startup republish — hash first, legacy string key fallback. */
export async function readFollowerCountForRepublish(deviceId: string): Promise<number | null> {
  const runtime = getIgDeviceRuntimeCache();
  const local = runtime.getFollowers(deviceId);
  if (local !== undefined) return local;

  const redisSvc = getRedisService();
  if (!redisSvc?.isRedisConnected()) return null;
  const key = REDIS_KEYS.deviceHash(deviceId);
  try {
    const client = redisSvc.getClient();
    const keyType = await client.type(key);
    if (keyType === 'hash') {
      const raw = await client.hGet(key, 'ig_follower_count');
      if (raw != null && raw !== '') {
        const n = parseInt(raw, 10);
        if (!Number.isNaN(n)) {
          runtime.setFollowers(deviceId, n);
          return n;
        }
      }
    }
    const legacy = await client.get(REDIS_KEYS.deviceFollowers(deviceId));
    if (legacy !== null) {
      const n = parseInt(legacy, 10);
      if (!Number.isNaN(n)) {
        runtime.setFollowers(deviceId, n);
        return n;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Immediate durable write for screen-critical fields. On failure: log and continue. */
export async function syncScreenFieldImmediate(
  deviceId: string,
  field: 'ig_follower_count' | 'gmb_review_count',
  value: number
): Promise<void> {
  const redisSvc = getRedisService();
  if (!redisSvc?.isRedisConnected()) return;
  try {
    const key = REDIS_KEYS.deviceHash(deviceId);
    const client = redisSvc.getClient();
    const type = await client.type(key);
    if (type === 'hash') {
      await client.hSet(key, field, String(value));
    }
  } catch (err: unknown) {
    logger.warn('[IG_RUNTIME_CACHE] immediate sync failed', {
      deviceId,
      field,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
