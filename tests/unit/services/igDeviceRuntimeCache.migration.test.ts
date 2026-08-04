import { describe, expect, it, beforeEach } from 'bun:test';
import {
  migrateDeviceKeysToHash,
  resetIgDeviceRuntimeCacheForTests
} from '../../../src/services/igDeviceRuntimeCache';

describe('migrateDeviceKeysToHash', () => {
  beforeEach(() => {
    resetIgDeviceRuntimeCacheForTests();
  });

  it('converts legacy STRING device keys to hash', async () => {
    const store = new Map<string, { type: string; value: string }>();
    const redis = {
      scan: async (cursor: number) => {
        if (cursor !== 0) return { cursor: 0, keys: [] as string[] };
        return { cursor: 0, keys: ['proof.mqtt:device:DEVICE-1'] };
      },
      type: async (key: string) => store.get(key)?.type ?? 'none',
      get: async (key: string) => store.get(key)?.value ?? null,
      del: async (key: string) => {
        store.delete(key);
        return 1;
      },
      hSet: async (key: string, fields: Record<string, string>) => {
        store.set(key, { type: 'hash', value: JSON.stringify(fields) });
        return Object.keys(fields).length;
      },
      expire: async () => true
    };

    store.set('proof.mqtt:device:DEVICE-1', {
      type: 'string',
      value: JSON.stringify({
        instagramAccountId: 'ig-123',
        accessToken: 'tok',
        userId: 'u1'
      })
    });

    const migrated = await migrateDeviceKeysToHash(redis as never);
    expect(migrated).toBe(1);
    expect(store.get('proof.mqtt:device:DEVICE-1')?.type).toBe('hash');
  });

  it('returns 0 when no string keys remain', async () => {
    const redis = {
      scan: async () => ({ cursor: 0, keys: [] as string[] }),
      type: async () => 'hash',
      get: async () => null,
      del: async () => 0,
      hSet: async () => 0,
      expire: async () => true
    };

    await expect(migrateDeviceKeysToHash(redis as never)).resolves.toBe(0);
  });
});
