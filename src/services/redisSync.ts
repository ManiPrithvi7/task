import type { RedisClientType } from 'redis';
import { REDIS_KEYS } from '../constants/redisKeys';
import {
  getIgDeviceRuntimeCache,
  type DeviceRuntimeState
} from './igDeviceRuntimeCache';
import { getLocalProvCache } from './localCaches';
import { logger } from '../utils/logger';

const BATCH_INTERVAL_MS = 5 * 60 * 1000;
const DEVICE_HASH_TTL_SEC = 7 * 24 * 3600;

/** Fields synced on the 5-minute batch (not screen-critical). */
const BATCH_SYNC_FIELDS = new Set([
  'power_save',
  'ota_deferred_at',
  'ota_status',
  'registered_at',
  'status',
  'ig_follower_count',
  'gmb_review_count'
]);

export class RedisSyncService {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  start(redis: RedisClientType): void {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => {
      void this.sync(redis);
    }, BATCH_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  async sync(redis: RedisClientType): Promise<void> {
    const cache = getIgDeviceRuntimeCache();
    const dirtyDevices = cache.getDirtyDevices();
    const prov = getLocalProvCache();
    const hasProvDirty = prov.dirtyTokens.size > 0;

    if (dirtyDevices.length === 0 && !hasProvDirty) return;

    const pipeline = redis.multi();

    for (const [deviceId, state] of dirtyDevices) {
      const updates = buildBatchUpdates(state);
      if (Object.keys(updates).length === 0) {
        cache.clearDirty(deviceId);
        continue;
      }
      const key = REDIS_KEYS.deviceHash(deviceId);
      pipeline.hSet(key, updates);
      pipeline.expire(key, DEVICE_HASH_TTL_SEC);
      cache.clearDirty(deviceId);
    }

    for (const token of [...prov.dirtyTokens]) {
      const local = prov.tokens.get(token);
      if (local?.consumed) {
        pipeline.hSet(REDIS_KEYS.provToken(token), {
          consumed: '1',
          consumedAt: String(local.consumedAt)
        });
      }
      prov.dirtyTokens.delete(token);
    }

    try {
      await pipeline.exec();
    } catch (err: unknown) {
      logger.warn('[REDIS_SYNC] batch sync failed', {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  async flush(redis: RedisClientType): Promise<void> {
    await this.sync(redis);
  }
}

function buildBatchUpdates(state: DeviceRuntimeState): Record<string, string> {
  const updates: Record<string, string> = {};
  for (const field of state.dirtyFields) {
    if (!BATCH_SYNC_FIELDS.has(field)) continue;
    if (field === 'power_save') {
      updates.power_save = state.powerSave ? '1' : '0';
    } else if (field === 'ota_deferred_at' && state.otaDeferredAt !== undefined) {
      updates.ota_deferred_at = String(state.otaDeferredAt);
    } else if (field === 'ota_status' && state.otaStatus !== undefined) {
      updates.ota_status = state.otaStatus;
    } else if (field === 'registered_at' && state.registeredAt !== undefined) {
      updates.registered_at = String(state.registeredAt);
    } else if (field === 'status' && state.status !== undefined) {
      updates.status = state.status;
    } else if (field === 'ig_follower_count' && state.igFollowerCount !== undefined) {
      updates.ig_follower_count = String(state.igFollowerCount);
    } else if (field === 'gmb_review_count' && state.gmbReviewCount !== undefined) {
      updates.gmb_review_count = String(state.gmbReviewCount);
    }
  }
  return updates;
}

let syncInstance: RedisSyncService | null = null;

export function getRedisSyncService(): RedisSyncService {
  if (!syncInstance) syncInstance = new RedisSyncService();
  return syncInstance;
}
