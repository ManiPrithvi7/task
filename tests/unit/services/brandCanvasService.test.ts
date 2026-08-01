/**
 * brandCanvasService — Comprehensive Test Suite
 *
 * Priority coverage:
 *   P0: getCanvasCacheTtlSec env parsing
 *   P0: getCachedBrandCanvasAd cache hit/miss/set
 *   P1: invalidateCanvasCache, buildBrandCanvasPayload fallbacks
 *   P2: getRunningBrandCanvasAd ObjectId + null path
 */

import mongoose from 'mongoose';
import {
  buildBrandCanvasPayload,
  getCanvasCacheTtlSec,
  getCachedBrandCanvasAd,
  getRunningBrandCanvasAd,
  invalidateCanvasCache,
  type CachedBrandCanvasDto
} from '@/services/brandCanvasService';
import { Ad, AdType, AdStatus, type IAd } from '@/models/Ad';

// --- Mocks ---

// In-memory mock for the local cache
const mockCacheMap = new Map<string, unknown>();
const mockLocalCache = {
  get: jest.fn((key: string) => mockCacheMap.get(key) || null),
  set: jest.fn((key: string, val: unknown, _ttl?: number) => {
    mockCacheMap.set(key, val);
  }),
  del: jest.fn((key: string) => {
    mockCacheMap.delete(key);
  })
};

jest.mock('@/services/localCaches', () => ({
  getLocalCanvasActiveCache: jest.fn(() => mockLocalCache)
}));

jest.mock('@/models/Ad', () => ({
  Ad: {
    findOne: jest.fn()
  },
  AdType: { BRAND_CANVAS: 'BRAND_CANVAS' },
  AdStatus: { RUNNING: 'RUNNING' }
}));

// --- Tests ---

describe('brandCanvasService', () => {
  const VALID_USER_ID = '507f1f77bcf86cd799439011';
  const adDocBase = {
    _id: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(VALID_USER_ID),
    type: AdType.BRAND_CANVAS,
    status: AdStatus.RUNNING,
    name: 'Test Ad',
    creativeUrl: 'https://example.com/img.png',
    templateData: {},
    updatedAt: new Date('2024-01-01T00:00:00Z')
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockCacheMap.clear();
  });

  /* ══════════════════════════════════════════════════════════════
   * P0: getCanvasCacheTtlSec
   * ══════════════════════════════════════════════════════════════ */

  describe('getCanvasCacheTtlSec', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    test('defaults to 3600 when no env vars are set', () => {
      delete process.env.CANVAS_CACHE_TTL_SEC;
      delete process.env.PROMOTION_CACHE_TTL_SEC;
      expect(getCanvasCacheTtlSec()).toBe(3600);
    });

    test('uses CANVAS_CACHE_TTL_SEC when set', () => {
      process.env.CANVAS_CACHE_TTL_SEC = '1800';
      process.env.PROMOTION_CACHE_TTL_SEC = '9999';
      expect(getCanvasCacheTtlSec()).toBe(1800);
    });

    test('falls back to PROMOTION_CACHE_TTL_SEC if CANVAS is invalid', () => {
      process.env.CANVAS_CACHE_TTL_SEC = 'abc';
      process.env.PROMOTION_CACHE_TTL_SEC = '7200';
      expect(getCanvasCacheTtlSec()).toBe(7200);
    });

    test('uses PROMOTION_CACHE_TTL_SEC when CANVAS is unset', () => {
      delete process.env.CANVAS_CACHE_TTL_SEC;
      process.env.PROMOTION_CACHE_TTL_SEC = '7200';
      expect(getCanvasCacheTtlSec()).toBe(7200);
    });

    test('falls back to 3600 if both are invalid (NaN)', () => {
      process.env.CANVAS_CACHE_TTL_SEC = 'NaN';
      process.env.PROMOTION_CACHE_TTL_SEC = 'undefined';
      expect(getCanvasCacheTtlSec()).toBe(3600);
    });

    test('falls back to 3600 if value is 0 or negative', () => {
      process.env.CANVAS_CACHE_TTL_SEC = '0';
      expect(getCanvasCacheTtlSec()).toBe(3600);

      process.env.CANVAS_CACHE_TTL_SEC = '-10';
      expect(getCanvasCacheTtlSec()).toBe(3600);
    });

    test('floors fractional values', () => {
      process.env.CANVAS_CACHE_TTL_SEC = '5.7';
      expect(getCanvasCacheTtlSec()).toBe(5);
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P0: getCachedBrandCanvasAd
   * ══════════════════════════════════════════════════════════════ */

  describe('getCachedBrandCanvasAd', () => {
    const mockAd = { ...adDocBase, templateData: { Offer: '50% Off' } } as unknown as IAd;

    beforeEach(() => {
      (Ad.findOne as jest.Mock).mockReturnValue({
        sort: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(mockAd)
        })
      });
    });

    test('cache hit: returns cached DTO and skips Mongo query', async () => {
      const cachedDto: CachedBrandCanvasDto = {
        _id: String(adDocBase._id),
        userId: VALID_USER_ID,
        name: 'Cached Ad',
        creativeUrl: 'cached.png',
        templateData: { Offer: 'Cached Offer' },
        status: AdStatus.RUNNING,
        updatedAt: adDocBase.updatedAt.toISOString()
      };
      mockCacheMap.set(`canvas:active:${VALID_USER_ID}`, cachedDto);

      const result = await getCachedBrandCanvasAd(VALID_USER_ID);

      expect(result).toEqual(cachedDto as unknown as IAd);
      expect(Ad.findOne).not.toHaveBeenCalled();
      expect(mockLocalCache.set).not.toHaveBeenCalled();
    });

    test('cache miss + ad found: returns ad and sets cache', async () => {
      const result = await getCachedBrandCanvasAd(VALID_USER_ID);

      expect(result).toEqual(mockAd);
      expect(Ad.findOne).toHaveBeenCalledTimes(1);
      expect(mockLocalCache.set).toHaveBeenCalledTimes(1);

      const [key, dto] = mockLocalCache.set.mock.calls[0];
      expect(key).toBe(`canvas:active:${VALID_USER_ID}`);
      expect((dto as CachedBrandCanvasDto).name).toBe('Test Ad');
      expect((dto as CachedBrandCanvasDto).userId).toBe(VALID_USER_ID);
    });

    test('cache miss + no ad found: returns null and does NOT set cache', async () => {
      (Ad.findOne as jest.Mock).mockReturnValue({
        sort: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(null)
        })
      });

      const result = await getCachedBrandCanvasAd(VALID_USER_ID);

      expect(result).toBeNull();
      expect(mockLocalCache.set).not.toHaveBeenCalled();
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P1: invalidateCanvasCache
   * ══════════════════════════════════════════════════════════════ */

  describe('invalidateCanvasCache', () => {
    test('deletes the active canvas key for the user', async () => {
      await invalidateCanvasCache(VALID_USER_ID);
      expect(mockLocalCache.del).toHaveBeenCalledWith(`canvas:active:${VALID_USER_ID}`);
    });

    test('is idempotent when key does not exist', async () => {
      await invalidateCanvasCache('nonexistent_id');
      expect(mockLocalCache.del).toHaveBeenCalledWith('canvas:active:nonexistent_id');
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P1: buildBrandCanvasPayload
   * ══════════════════════════════════════════════════════════════ */

  describe('buildBrandCanvasPayload', () => {
    test('maps creativeUrl and templateData (happy path)', () => {
      const ad: CachedBrandCanvasDto = {
        _id: 'ad1',
        userId: 'user1',
        name: 'Spring Promo',
        creativeUrl: 'https://cdn.example.com/canvas.png',
        templateData: {
          Offer: '15%',
          message: 'Spring special',
          qrText: 'https://example.com/qr'
        },
        status: AdStatus.RUNNING,
        updatedAt: new Date().toISOString()
      };

      const payload = buildBrandCanvasPayload(ad);
      expect(payload.platform).toBe('brand_canvas');
      expect(payload.creativeUrl).toBe('https://cdn.example.com/canvas.png');
      expect(payload.templateData).toEqual(ad.templateData);
      expect(payload.Offer).toBe('15%');
      expect(payload.message).toBe('Spring special');
      expect(payload.qrText).toBe('https://example.com/qr');
    });

    test('templateData undefined/null defaults to {}', () => {
      const ad = { ...adDocBase, templateData: undefined } as unknown as IAd;
      const payload = buildBrandCanvasPayload(ad);
      expect(payload.templateData).toEqual({});
    });

    test('camelCase Offer precedence over lowercase offer', () => {
      const ad = {
        ...adDocBase,
        templateData: { Offer: 'Correct', offer: 'Wrong' }
      } as unknown as IAd;
      expect(buildBrandCanvasPayload(ad).Offer).toBe('Correct');
    });

    test('lowercase offer fallback when Offer missing', () => {
      const ad = {
        ...adDocBase,
        templateData: { offer: 'Fallback' }
      } as unknown as IAd;
      expect(buildBrandCanvasPayload(ad).Offer).toBe('Fallback');
    });

    test('non-string Offer (e.g. number) results in empty string', () => {
      const ad = { ...adDocBase, templateData: { Offer: 15 } } as unknown as IAd;
      expect(buildBrandCanvasPayload(ad).Offer).toBe('');
    });

    test('message fallback to name when message missing or non-string', () => {
      const ad1 = {
        ...adDocBase,
        templateData: { message: 123 },
        name: 'MyName'
      } as unknown as IAd;
      expect(buildBrandCanvasPayload(ad1).message).toBe('MyName');

      const ad2 = {
        ...adDocBase,
        templateData: {},
        name: 'MyName'
      } as unknown as IAd;
      expect(buildBrandCanvasPayload(ad2).message).toBe('MyName');
    });

    test('qrText fallback to qrUrl when qrText missing', () => {
      const ad = {
        ...adDocBase,
        templateData: { qrUrl: 'http://qr.url' }
      } as unknown as IAd;
      expect(buildBrandCanvasPayload(ad).qrText).toBe('http://qr.url');
    });

    test('qrText fallback to creativeUrl when both qrText and qrUrl missing', () => {
      const ad = {
        ...adDocBase,
        creativeUrl: 'http://creative.url'
      } as unknown as IAd;
      expect(buildBrandCanvasPayload(ad).qrText).toBe('http://creative.url');
    });

    test('name/creativeUrl empty/undefined defaults to empty string', () => {
      const ad = {
        ...adDocBase,
        name: undefined,
        creativeUrl: undefined
      } as unknown as IAd;
      const payload = buildBrandCanvasPayload(ad);
      expect(payload.message).toBe('');
      expect(payload.creativeUrl).toBe('');
      expect(payload.qrText).toBe('');
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P2: getRunningBrandCanvasAd
   * ══════════════════════════════════════════════════════════════ */

  describe('getRunningBrandCanvasAd', () => {
    test('returns null for invalid userId', async () => {
      const result = await getRunningBrandCanvasAd('invalid-id');
      expect(result).toBeNull();
      expect(Ad.findOne).not.toHaveBeenCalled();
    });

    test('passes mongoose.Types.ObjectId instance to Ad.findOne, not string', async () => {
      (Ad.findOne as jest.Mock).mockReturnValue({
        sort: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(null)
        })
      });

      await getRunningBrandCanvasAd(VALID_USER_ID);

      expect(Ad.findOne).toHaveBeenCalledTimes(1);
      const filterArg = (Ad.findOne as jest.Mock).mock.calls[0][0];
      expect(filterArg.userId).toBeInstanceOf(mongoose.Types.ObjectId);
      expect(filterArg.userId.toString()).toBe(VALID_USER_ID);

      expect(filterArg).toEqual({
        userId: expect.any(mongoose.Types.ObjectId),
        type: AdType.BRAND_CANVAS,
        status: AdStatus.RUNNING
      });
    });

    test('returns null when no matching ad is found', async () => {
      (Ad.findOne as jest.Mock).mockReturnValue({
        sort: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(null)
        })
      });

      const result = await getRunningBrandCanvasAd(VALID_USER_ID);
      expect(result).toBeNull();
    });

    test('returns ad and sorts by updatedAt desc', async () => {
      const lean = jest.fn().mockResolvedValue({
        ...adDocBase,
        name: 'Test'
      });
      const sort = jest.fn().mockReturnValue({ lean });
      (Ad.findOne as jest.Mock).mockReturnValue({ sort });

      const result = await getRunningBrandCanvasAd(VALID_USER_ID);

      expect(sort).toHaveBeenCalledWith({ updatedAt: -1 });
      expect(result?.name).toBe('Test');
    });
  });
});
