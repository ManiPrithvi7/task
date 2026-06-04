import { readPosDailyAggregate } from '@/services/pos/readPosDailyAggregate';

jest.mock('@/services/influxService', () => ({
  getInfluxService: jest.fn()
}));
jest.mock('@/services/redisService', () => ({
  getRedisService: jest.fn()
}));

import { getInfluxService } from '@/services/influxService';
import { getRedisService } from '@/services/redisService';

const mockGetInflux = getInfluxService as jest.MockedFunction<typeof getInfluxService>;
const mockGetRedis = getRedisService as jest.MockedFunction<typeof getRedisService>;

describe('readPosDailyAggregate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRedis.mockReturnValue(null);
  });

  it('returns cached count on Redis hit', async () => {
    const get = jest.fn().mockResolvedValueOnce('12').mockResolvedValueOnce('Widget A');
    mockGetRedis.mockReturnValue({
      isRedisConnected: () => true,
      getClient: () => ({ get })
    } as never);

    const queryPosDailyOrderCount = jest.fn();
    mockGetInflux.mockReturnValue({ queryPosDailyOrderCount } as never);

    const result = await readPosDailyAggregate('user-1', new Date('2026-06-04T15:00:00Z'));

    expect(result).toEqual({ orderCountToday: 12, topSellerLine: 'Widget A' });
    expect(queryPosDailyOrderCount).not.toHaveBeenCalled();
  });

  it('queries Influx on cache miss and backfills Redis', async () => {
    const set = jest.fn().mockResolvedValue('OK');
    const get = jest.fn().mockResolvedValue(null);
    mockGetRedis.mockReturnValue({
      isRedisConnected: () => true,
      getClient: () => ({ get, set })
    } as never);

    const queryPosDailyOrderCount = jest.fn().mockResolvedValue(47);
    mockGetInflux.mockReturnValue({ queryPosDailyOrderCount } as never);

    const result = await readPosDailyAggregate('user-2', new Date('2026-06-04T15:00:00Z'), {
      platform: 'shopify'
    });

    expect(result.orderCountToday).toBe(47);
    expect(queryPosDailyOrderCount).toHaveBeenCalledWith(
      'user-2',
      expect.any(Date),
      'shopify'
    );
    expect(set).toHaveBeenCalledWith(
      expect.stringContaining('cache:pos:daily:user-2:'),
      '47',
      expect.objectContaining({ EX: expect.any(Number) })
    );
  });

  it('returns 0 when Influx is unavailable', async () => {
    mockGetInflux.mockReturnValue(null);

    const result = await readPosDailyAggregate('user-3');

    expect(result).toEqual({ orderCountToday: 0, topSellerLine: undefined });
  });
});
