import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { getRedisSyncService } from '../../../src/services/redisSync';
import {
  getIgDeviceRuntimeCache,
  resetIgDeviceRuntimeCacheForTests
} from '../../../src/services/igDeviceRuntimeCache';
import { getLocalProvCache, resetLocalCachesForTests } from '../../../src/services/localCaches';

describe('RedisSyncService', () => {
  beforeEach(() => {
    resetIgDeviceRuntimeCacheForTests();
    resetLocalCachesForTests();
  });

  it('syncs dirty power_save and consumed prov tokens via pipeline', async () => {
    const cache = getIgDeviceRuntimeCache();
    cache.setPowerSave('d1', true);
    cache.markDirty('d1', 'power_save');

    const prov = getLocalProvCache();
    prov.tokens.set('tok1', {
      deviceId: 'd1',
      userId: 'u1',
      consumed: true,
      consumedAt: 123,
      createdAt: 1,
      expiresAt: Date.now() + 60_000
    });
    prov.dirtyTokens.add('tok1');

    const hSetCalls: unknown[] = [];
    const redis = {
      multi: () => {
        const ops: Array<() => void> = [];
        return {
          hSet: (key: string, fields: Record<string, string>) => {
            hSetCalls.push({ key, fields });
            ops.push(() => undefined);
            return this;
          },
          expire: () => {
            ops.push(() => undefined);
            return this;
          },
          exec: async () => ops.map(() => [null, 1])
        };
      }
    } as any;

    // Fix fluent this binding
    const pipelineOps: Array<{ op: string; args: unknown[] }> = [];
    const multi = {
      hSet(...args: unknown[]) {
        pipelineOps.push({ op: 'hSet', args });
        return multi;
      },
      expire(...args: unknown[]) {
        pipelineOps.push({ op: 'expire', args });
        return multi;
      },
      async exec() {
        return pipelineOps.map(() => [null, 1]);
      }
    };
    const redisFixed = { multi: () => multi } as any;

    await getRedisSyncService().sync(redisFixed);

    expect(pipelineOps.some((o) => o.op === 'hSet')).toBe(true);
    expect(cache.getDirtyDevices().length).toBe(0);
    expect(prov.dirtyTokens.size).toBe(0);
  });

  it('syncs dirty ig_follower_count and gmb_review_count via pipeline', async () => {
    const cache = getIgDeviceRuntimeCache();
    cache.setFollowers('d2', 42);
    cache.setGmbReviewCount('d2', 7);
    cache.markDirty('d2', 'ig_follower_count', 'gmb_review_count');

    const pipelineOps: Array<{ op: string; args: unknown[] }> = [];
    const multi = {
      hSet(...args: unknown[]) {
        pipelineOps.push({ op: 'hSet', args });
        return multi;
      },
      expire(...args: unknown[]) {
        pipelineOps.push({ op: 'expire', args });
        return multi;
      },
      async exec() {
        return pipelineOps.map(() => [null, 1]);
      }
    };
    const redisFixed = { multi: () => multi } as any;

    await getRedisSyncService().sync(redisFixed);

    const hSet = pipelineOps.find((o) => o.op === 'hSet');
    expect(hSet?.args[1]).toEqual({
      ig_follower_count: '42',
      gmb_review_count: '7'
    });
    expect(cache.getDirtyDevices().length).toBe(0);
  });
});
