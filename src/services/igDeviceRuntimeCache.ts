import type { RedisClientType } from 'redis';
import { REDIS_KEYS } from '../constants/redisKeys';
import { Device } from '../models/Device';
import { DeviceOtaState } from '../models/DeviceOtaState';
import { Social, Provider } from '../models/Social';
import { getActiveDeviceCache } from './deviceService';
import { getRedisService } from './redisService';
import { getLocalOtaFleetTracker } from './igPollCoordination';
import { logger } from '../utils/logger';

export interface DeviceRuntimeState {
  businessId?: string;
  registeredAt?: number;
  igAccountId?: string;
  igAccessToken?: string;
  igFollowerCount?: number;
  /** Epoch ms when igFollowerCount was last set — used for milestone velocity. */
  lastFollowerCountTimestamp?: number;
  gmbProfileId?: string;
  gmbAccessToken?: string;
  gmbReviewCount?: number;
  status?: 'active' | 'inactive';
  powerSave?: boolean;
  otaCurrentVersion?: string;
  otaTargetVersion?: string;
  otaStatus?: string;
  otaDeliveredAt?: number;
  otaDeferredAt?: number;

  /** Local-only */
  lastPubMs?: number;
  igBackoffUntil?: number;
  igConsecutiveErrors?: number;
  powerSaveSet?: boolean;
  powerSaveSetAt?: number;

  dirtyFields: Set<string>;
}

export interface ResolvedDeviceMeta {
  instagramAccountId: string;
  accessToken: string;
  businessId?: string;
}

const DEVICE_HASH_TTL_SEC = 7 * 24 * 3600;

class IgDeviceRuntimeCacheImpl {
  private devices = new Map<string, DeviceRuntimeState>();
  private gmbProfileIndex = new Map<string, Set<string>>();

  private entry(deviceId: string): DeviceRuntimeState {
    let e = this.devices.get(deviceId);
    if (!e) {
      e = { dirtyFields: new Set() };
      this.devices.set(deviceId, e);
    }
    return e;
  }

  get(deviceId: string): DeviceRuntimeState | undefined {
    return this.devices.get(deviceId);
  }

  has(deviceId: string): boolean {
    return this.devices.has(deviceId);
  }

  getByBusinessId(businessId: string): DeviceRuntimeState[] {
    return [...this.devices.values()].filter((d) => d.businessId === businessId);
  }

  getByGmbProfileId(gmbProfileId: string): string[] {
    return [...(this.gmbProfileIndex.get(gmbProfileId) ?? [])];
  }

  private indexGmb(deviceId: string, profileId: string | undefined, prev?: string): void {
    if (prev && prev !== profileId) {
      this.gmbProfileIndex.get(prev)?.delete(deviceId);
    }
    if (profileId) {
      let set = this.gmbProfileIndex.get(profileId);
      if (!set) {
        set = new Set();
        this.gmbProfileIndex.set(profileId, set);
      }
      set.add(deviceId);
    }
  }

  set(deviceId: string, data: Partial<Omit<DeviceRuntimeState, 'dirtyFields'>>): void {
    const e = this.entry(deviceId);
    const prevGmb = e.gmbProfileId;
    Object.assign(e, data);
    if (data.gmbProfileId !== undefined) {
      this.indexGmb(deviceId, data.gmbProfileId, prevGmb);
    }
  }

  getFollowers(deviceId: string): number | undefined {
    return this.devices.get(deviceId)?.igFollowerCount;
  }

  setFollowers(deviceId: string, count: number, atMs: number = Date.now()): void {
    const e = this.entry(deviceId);
    e.igFollowerCount = count;
    e.lastFollowerCountTimestamp = atMs;
  }

  getLastFollowerCountTimestamp(deviceId: string): number | undefined {
    return this.devices.get(deviceId)?.lastFollowerCountTimestamp;
  }

  getGmbReviewCount(deviceId: string): number | undefined {
    return this.devices.get(deviceId)?.gmbReviewCount;
  }

  setGmbReviewCount(deviceId: string, count: number): void {
    this.entry(deviceId).gmbReviewCount = count;
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

  getOtaStatus(deviceId: string): string | undefined {
    return this.devices.get(deviceId)?.otaStatus;
  }

  markDirty(deviceId: string, ...fields: string[]): void {
    const e = this.entry(deviceId);
    for (const f of fields) e.dirtyFields.add(f);
  }

  getDirtyDevices(): Array<[string, DeviceRuntimeState]> {
    return [...this.devices.entries()].filter(([, s]) => s.dirtyFields.size > 0);
  }

  clearDirty(deviceId: string): void {
    this.devices.get(deviceId)?.dirtyFields.clear();
  }

  delete(deviceId: string): void {
    const e = this.devices.get(deviceId);
    if (e?.gmbProfileId) {
      this.gmbProfileIndex.get(e.gmbProfileId)?.delete(deviceId);
    }
    this.devices.delete(deviceId);
  }

  hydrateFromHashFields(deviceId: string, fields: Record<string, string>): void {
    const e = this.entry(deviceId);
    const prevGmb = e.gmbProfileId;

    // Dual-read: new hashes use business_id; legacy hashes (7-day TTL) may still carry userId/user_id
    const businessIdField = fields.business_id ?? fields.businessId ?? fields.userId ?? fields.user_id;
    if (businessIdField !== undefined) e.businessId = businessIdField || undefined;
    if (fields.registered_at !== undefined) {
      const n = parseInt(fields.registered_at, 10);
      if (!Number.isNaN(n)) e.registeredAt = n;
    }
    if (fields.ig_accountId !== undefined) e.igAccountId = fields.ig_accountId || undefined;
    if (fields.ig_accessToken !== undefined) e.igAccessToken = fields.ig_accessToken || undefined;
    if (fields.ig_follower_count !== undefined) {
      const n = parseInt(fields.ig_follower_count, 10);
      if (!Number.isNaN(n)) e.igFollowerCount = n;
    }
    if (fields.gmb_profile_id !== undefined) e.gmbProfileId = fields.gmb_profile_id || undefined;
    if (fields.gmb_accessToken !== undefined) e.gmbAccessToken = fields.gmb_accessToken || undefined;
    if (fields.gmb_review_count !== undefined) {
      const n = parseInt(fields.gmb_review_count, 10);
      if (!Number.isNaN(n)) e.gmbReviewCount = n;
    }
    if (fields.status === 'active' || fields.status === 'inactive') e.status = fields.status;
    if (fields.power_save !== undefined) {
      e.powerSave = fields.power_save === '1' || fields.power_save === 'true';
    }
    if (fields.ota_current_version !== undefined) e.otaCurrentVersion = fields.ota_current_version;
    if (fields.ota_target_version !== undefined) e.otaTargetVersion = fields.ota_target_version;
    if (fields.ota_status !== undefined) e.otaStatus = fields.ota_status;
    if (fields.ota_delivered_at !== undefined) {
      const n = parseInt(fields.ota_delivered_at, 10);
      if (!Number.isNaN(n)) e.otaDeliveredAt = n;
    }
    if (fields.ota_deferred_at !== undefined) {
      const n = parseInt(fields.ota_deferred_at, 10);
      if (!Number.isNaN(n)) e.otaDeferredAt = n;
    }

    this.indexGmb(deviceId, e.gmbProfileId, prevGmb);
  }

  runtimeDataToHash(state: DeviceRuntimeState): Record<string, string> {
    const out: Record<string, string> = {};
    if (state.businessId !== undefined) out.business_id = state.businessId;
    if (state.registeredAt !== undefined) out.registered_at = String(state.registeredAt);
    if (state.igAccountId !== undefined) out.ig_accountId = state.igAccountId;
    if (state.igAccessToken !== undefined) out.ig_accessToken = state.igAccessToken;
    if (state.igFollowerCount !== undefined) out.ig_follower_count = String(state.igFollowerCount);
    if (state.gmbProfileId !== undefined) out.gmb_profile_id = state.gmbProfileId;
    if (state.gmbAccessToken !== undefined) out.gmb_accessToken = state.gmbAccessToken;
    if (state.gmbReviewCount !== undefined) out.gmb_review_count = String(state.gmbReviewCount);
    if (state.status !== undefined) out.status = state.status;
    if (state.powerSave !== undefined) out.power_save = state.powerSave ? '1' : '0';
    if (state.otaCurrentVersion !== undefined) out.ota_current_version = state.otaCurrentVersion;
    if (state.otaTargetVersion !== undefined) out.ota_target_version = state.otaTargetVersion;
    if (state.otaStatus !== undefined) out.ota_status = state.otaStatus;
    if (state.otaDeliveredAt !== undefined) out.ota_delivered_at = String(state.otaDeliveredAt);
    if (state.otaDeferredAt !== undefined) out.ota_deferred_at = String(state.otaDeferredAt);
    return out;
  }

  /** L1 local → L2 Redis hash → L3 Mongo → backfill Redis. */
  async resolveWithCache(deviceId: string): Promise<DeviceRuntimeState | null> {
    const local = this.devices.get(deviceId);
    if (local && (local.igAccountId || local.businessId || local.otaStatus)) {
      return local;
    }

    const redisSvc = getRedisService();
    if (redisSvc?.isRedisConnected()) {
      try {
        const client = redisSvc.getClient();
        const key = REDIS_KEYS.deviceHash(deviceId);
        const hash = await client.hGetAll(key);
        if (hash && Object.keys(hash).length > 0) {
          this.hydrateFromHashFields(deviceId, hash);
          return this.entry(deviceId);
        }
      } catch (err: unknown) {
        logger.debug('[IG_RUNTIME_CACHE] L2 redis miss/error', {
          deviceId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    const fromMongo = await queryMongoDeviceState(deviceId);
    if (fromMongo) {
      this.set(deviceId, fromMongo);
      const hash = this.runtimeDataToHash(this.entry(deviceId));
      if (redisSvc?.isRedisConnected() && Object.keys(hash).length > 0) {
        try {
          const key = REDIS_KEYS.deviceHash(deviceId);
          await redisSvc.getClient().hSet(key, hash);
          await redisSvc.getClient().expire(key, DEVICE_HASH_TTL_SEC);
        } catch {
          /* non-fatal */
        }
      }
      return this.entry(deviceId);
    }

    return this.devices.get(deviceId) ?? null;
  }

  /** ActiveDevice first, then Redis hash. */
  async resolveMeta(deviceId: string): Promise<ResolvedDeviceMeta | null> {
    const local = await getActiveDeviceCache().getActive(deviceId);
    if (local?.instagramAccountId?.trim() && local.accessToken?.trim()) {
      return {
        instagramAccountId: local.instagramAccountId.trim(),
        accessToken: local.accessToken.trim(),
        businessId: local.businessId?.trim() || undefined
      };
    }

    const cached = this.devices.get(deviceId);
    if (cached?.igAccountId?.trim() && cached.igAccessToken?.trim()) {
      return {
        instagramAccountId: cached.igAccountId.trim(),
        accessToken: cached.igAccessToken.trim(),
        businessId: cached.businessId
      };
    }

    const resolved = await this.resolveWithCache(deviceId);
    if (resolved?.igAccountId?.trim() && resolved.igAccessToken?.trim()) {
      return {
        instagramAccountId: resolved.igAccountId.trim(),
        accessToken: resolved.igAccessToken.trim(),
        businessId: resolved.businessId
      };
    }

    return null;
  }
}

function flattenLegacyJson(o: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const map: Record<string, string> = {
    business_id: 'business_id',
    businessId: 'business_id',
    userId: 'business_id',
    user_id: 'business_id',
    instagramAccountId: 'ig_accountId',
    accessToken: 'ig_accessToken',
    ig_accountId: 'ig_accountId',
    ig_accessToken: 'ig_accessToken',
    status: 'status'
  };
  for (const [k, field] of Object.entries(map)) {
    const v = o[k];
    if (typeof v === 'string') out[field] = v;
  }
  return out;
}

async function queryMongoDeviceState(
  deviceId: string
): Promise<Partial<Omit<DeviceRuntimeState, 'dirtyFields'>> | null> {
  try {
    const device = await Device.findOne({ clientId: deviceId })
      .select({
        businessId: 1,
        status: 1,
        provisionedAt: 1,
        createdAt: 1
      })
      .lean();
    if (!device) return null;

    const otaState = await DeviceOtaState.findOne({ deviceId })
      .select({ firmwareVersion: 1, otaTargetVersion: 1 })
      .lean();

    const businessId = device.businessId ? String(device.businessId) : undefined;
    const result: Partial<Omit<DeviceRuntimeState, 'dirtyFields'>> = {
      businessId,
      status: device.status === 'ACTIVE' ? 'active' : 'inactive',
      otaCurrentVersion: otaState?.firmwareVersion,
      otaTargetVersion: otaState?.otaTargetVersion,
      registeredAt: (device.provisionedAt ?? device.createdAt)?.getTime?.() ?? Date.now()
    };

    if (device.businessId) {
      const ig = await Social.findOne({
        businessId: device.businessId,
        provider: Provider.INSTAGRAM
      })
        .sort({ updatedAt: -1 })
        .select({ socialAccountId: 1, accessToken: 1 })
        .lean();
      if (ig) {
        result.igAccountId = ig.socialAccountId;
        result.igAccessToken = ig.accessToken;
      }

      const gmb = await Social.findOne({
        businessId: device.businessId,
        provider: Provider.GOOGLE_BUSINESS
      })
        .select({ accessToken: 1, socialAccountId: 1 })
        .lean();
      if (gmb) {
        result.gmbAccessToken = gmb.accessToken;
        result.gmbProfileId = gmb.socialAccountId;
      }
    }

    return result;
  } catch (err: unknown) {
    logger.debug('[IG_RUNTIME_CACHE] Mongo L3 failed', {
      deviceId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

let instance: IgDeviceRuntimeCacheImpl | null = null;

export function getIgDeviceRuntimeCache(): IgDeviceRuntimeCacheImpl {
  if (!instance) {
    instance = new IgDeviceRuntimeCacheImpl();
    getLocalOtaFleetTracker().setStatusReader((id) => instance?.getOtaStatus(id));
  }
  return instance;
}

export function resetIgDeviceRuntimeCacheForTests(): void {
  instance = null;
}

/** One-time startup sweep: convert legacy STRING device keys to hash. */
export async function migrateDeviceKeysToHash(redis: RedisClientType): Promise<number> {
  let cursor = 0;
  let migrated = 0;

  do {
    const reply = await redis.scan(cursor, { MATCH: 'proof.mqtt:device:*', COUNT: 100 });
    cursor = Number(reply.cursor);
    for (const key of reply.keys) {
      const type = await redis.type(key);
      if (type !== 'string') continue;
      const raw = await redis.get(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const flat = flattenLegacyJson(parsed);
        if (Object.keys(flat).length === 0) continue;
        await redis.del(key);
        await redis.hSet(key, flat);
        await redis.expire(key, DEVICE_HASH_TTL_SEC);
        migrated++;
      } catch {
        /* skip malformed legacy keys */
      }
    }
  } while (cursor !== 0);

  return migrated;
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
    const cache = getIgDeviceRuntimeCache();
    cache.setGmbReviewCount(deviceId, n);
    cache.set(deviceId, { gmbProfileId: locationId.trim() });
    return n;
  } catch {
    return undefined;
  }
}

/** Write device hash on connect (hash-only; overwrites in place). */
export async function writeDeviceHashOnConnect(
  deviceId: string,
  fields: Record<string, string>
): Promise<void> {
  const redisSvc = getRedisService();
  if (!redisSvc?.isRedisConnected()) {
    getIgDeviceRuntimeCache().hydrateFromHashFields(deviceId, fields);
    return;
  }
  const key = REDIS_KEYS.deviceHash(deviceId);
  const client = redisSvc.getClient();
  try {
    await client.hSet(key, fields);
    await client.expire(key, DEVICE_HASH_TTL_SEC);
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
  if (!redisSvc?.isRedisConnected()) {
    getIgDeviceRuntimeCache().delete(deviceId);
    return;
  }
  const key = REDIS_KEYS.deviceHash(deviceId);
  try {
    const client = redisSvc.getClient();
    await client.hSet(key, 'status', 'inactive');
    await client.expire(key, DEVICE_HASH_TTL_SEC);
  } catch (err: unknown) {
    logger.debug('[IG_RUNTIME_CACHE] markDeviceHashInactive failed', {
      deviceId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  getIgDeviceRuntimeCache().delete(deviceId);
}

/** Read follower count for startup republish — local cache first, then hash field. */
export async function readFollowerCountForRepublish(deviceId: string): Promise<number | null> {
  const runtime = getIgDeviceRuntimeCache();
  const local = runtime.getFollowers(deviceId);
  if (local !== undefined) return local;

  const redisSvc = getRedisService();
  if (!redisSvc?.isRedisConnected()) return null;
  const key = REDIS_KEYS.deviceHash(deviceId);
  try {
    const raw = await redisSvc.getClient().hGet(key, 'ig_follower_count');
    if (raw != null && raw !== '') {
      const n = parseInt(raw, 10);
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
  field:
    | 'ig_follower_count'
    | 'gmb_review_count'
    | 'ota_status'
    | 'ota_target_version'
    | 'ota_current_version'
    | 'ota_delivered_at'
    | 'ota_deferred_at'
    | 'ig_accessToken'
    | 'gmb_accessToken',
  value: string | number
): Promise<void> {
  const redisSvc = getRedisService();
  if (!redisSvc?.isRedisConnected()) return;
  try {
    const key = REDIS_KEYS.deviceHash(deviceId);
    const client = redisSvc.getClient();
    await client.hSet(key, field, String(value));
    await client.expire(key, DEVICE_HASH_TTL_SEC);
  } catch (err: unknown) {
    logger.warn('[IG_RUNTIME_CACHE] immediate sync failed', {
      deviceId,
      field,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/** Write multiple hash fields immediately (OTA / GMB fan-out). */
export async function syncHashFieldsImmediate(
  deviceId: string,
  fields: Record<string, string>
): Promise<void> {
  if (Object.keys(fields).length === 0) return;
  const redisSvc = getRedisService();
  if (!redisSvc?.isRedisConnected()) return;
  try {
    const key = REDIS_KEYS.deviceHash(deviceId);
    const client = redisSvc.getClient();
    await client.hSet(key, fields);
    await client.expire(key, DEVICE_HASH_TTL_SEC);
  } catch (err: unknown) {
    logger.warn('[IG_RUNTIME_CACHE] immediate multi sync failed', {
      deviceId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/** @deprecated unused redis param kept for call-site compatibility */
export type { RedisClientType };
