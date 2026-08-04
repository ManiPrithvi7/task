/**
 * TokenStore — P1 in-memory path + consumed marker coverage
 *
 * Redis/legacy dual-read paths are mocked lightly; primary focus is local prov-cache
 * + in-memory fallback behavior used when Redis is disconnected.
 */


jest.mock('@/services/redisService', () => ({
  getRedisService: jest.fn(),
}));

import { getRedisService } from '@/services/redisService';
import { getLocalProvCache } from '@/services/localCaches';
import { TokenStore } from '@/storage/tokenStore';

const TEST_DEVICE = 'DEVICE-TS-01';
const TEST_USER = '507f1f77bcf86cd799439011';
const TEST_TOKEN = 'jwt-token-abc';
const TTL_SECONDS = 300;

function makeInMemoryStore(): TokenStore {
  (getRedisService as jest.Mock).mockReturnValue({
    isRedisConnected: () => false,
    getClient: () => null,
  });
  return new TokenStore();
}

describe('TokenStore (in-memory mode)', () => {
  let store: TokenStore;

  beforeEach(() => {
    jest.clearAllMocks();
    getLocalProvCache().clear();
    store = makeInMemoryStore();
  });

  afterEach(() => {
    store.shutdown();
  });

  test('setToken writes local prov cache and in-memory maps', async () => {
    await store.setToken(TEST_TOKEN, TEST_DEVICE, TTL_SECONDS, TEST_DEVICE);

    const local = getLocalProvCache();
    expect(local.tokens.get(TEST_TOKEN)?.deviceId).toBe(TEST_DEVICE);
    expect(local.deviceIndex.get(TEST_DEVICE)).toBe(TEST_TOKEN);
    expect(await store.getDeviceByToken(TEST_TOKEN)).toBe(TEST_DEVICE);
  });

  test('getTokenByDevice returns active token', async () => {
    await store.setToken(TEST_TOKEN, TEST_DEVICE, TTL_SECONDS);

    expect(await store.getTokenByDevice(TEST_DEVICE)).toBe(TEST_TOKEN);
  });

  test('getDeviceByToken returns null for consumed local entry', async () => {
    await store.setToken(TEST_TOKEN, TEST_DEVICE, TTL_SECONDS);
    await store.markTokenConsumed(TEST_TOKEN, TTL_SECONDS);

    expect(await store.getDeviceByToken(TEST_TOKEN)).toBeNull();
    expect(await store.isTokenConsumed(TEST_TOKEN)).toBe(true);
  });

  test('deleteToken removes local cache and in-memory entry', async () => {
    await store.setToken(TEST_TOKEN, TEST_DEVICE, TTL_SECONDS);
    await store.deleteToken(TEST_TOKEN);

    expect(await store.getDeviceByToken(TEST_TOKEN)).toBeNull();
    expect(await store.getTokenByDevice(TEST_DEVICE)).toBeNull();
    expect(getLocalProvCache().tokens.has(TEST_TOKEN)).toBe(false);
  });

  test('hasActiveToken reflects stored token presence', async () => {
    expect(await store.hasActiveToken(TEST_DEVICE)).toBe(false);
    await store.setToken(TEST_TOKEN, TEST_DEVICE, TTL_SECONDS);
    expect(await store.hasActiveToken(TEST_DEVICE)).toBe(true);
  });

  test('getStats reports memory storage', async () => {
    await store.setToken(TEST_TOKEN, TEST_DEVICE, TTL_SECONDS);

    const stats = await store.getStats();

    expect(stats.storage).toBe('memory');
    expect(stats.tokenCount).toBeGreaterThanOrEqual(1);
    expect(stats.deviceCount).toBeGreaterThanOrEqual(1);
    expect(stats.connected).toBe(true);
  });

  test('shutdown clears local prov cache and in-memory state', async () => {
    await store.setToken(TEST_TOKEN, TEST_DEVICE, TTL_SECONDS);
    await store.markTokenConsumed(TEST_TOKEN, TTL_SECONDS);

    store.shutdown();

    expect(getLocalProvCache().tokens.size).toBe(0);
    expect(await store.getDeviceByToken(TEST_TOKEN)).toBeNull();
  });
});

describe('TokenStore (Redis HASH path)', () => {
  let store: TokenStore;
  let hGetAll: jest.Mock;
  let hSet: jest.Mock;
  let expire: jest.Mock;
  let del: jest.Mock;
  let get: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    getLocalProvCache().clear();

    hGetAll = jest.fn().mockResolvedValue({});
    hSet = jest.fn().mockResolvedValue(1);
    expire = jest.fn().mockResolvedValue(true);
    del = jest.fn().mockResolvedValue(1);
    get = jest.fn().mockResolvedValue(null);

    (getRedisService as jest.Mock).mockReturnValue({
      isRedisConnected: () => true,
      getClient: () => ({ hGetAll, hSet, expire, del, get, scan: jest.fn() }),
    });

    store = new TokenStore();
  });

  afterEach(() => {
    store.shutdown();
  });

  test('setToken writes Redis HASH when connected', async () => {
    await store.setToken(TEST_TOKEN, TEST_DEVICE, TTL_SECONDS, TEST_USER);

    expect(hSet).toHaveBeenCalled();
    expect(expire).toHaveBeenCalled();
  });

  test('isTokenConsumed reads legacy prov:consumed STRING dual-read', async () => {
    const crypto = await import('crypto');
    const hash = crypto.createHash('sha256').update(TEST_TOKEN, 'utf8').digest('hex');
    get.mockResolvedValueOnce('1');

    const consumed = await store.isTokenConsumed(TEST_TOKEN);

    expect(consumed).toBe(true);
    expect(get).toHaveBeenCalledWith(`prov:consumed:${hash}`);
  });

  test('getDeviceByToken hydrates local cache from Redis HASH', async () => {
    const expiresAt = Date.now() + TTL_SECONDS * 1000;
    hGetAll.mockResolvedValueOnce({
      deviceId: TEST_DEVICE,
      userId: TEST_USER,
      consumed: '0',
      expiresAt: String(expiresAt),
    });

    const deviceId = await store.getDeviceByToken(TEST_TOKEN);

    expect(deviceId).toBe(TEST_DEVICE);
    expect(getLocalProvCache().tokens.get(TEST_TOKEN)?.deviceId).toBe(TEST_DEVICE);
  });
});
