import {
  buildBrandCanvasPayload,
  getRunningBrandCanvasAd,
  type CachedBrandCanvasDto
} from '@/services/brandCanvasService';
import { AdType, AdStatus } from '@/models/Ad';

jest.mock('@/models/Ad', () => ({
  Ad: { findOne: jest.fn() },
  AdType: { BRAND_CANVAS: 'BRAND_CANVAS' },
  AdStatus: { RUNNING: 'RUNNING' }
}));

jest.mock('@/services/redisService', () => ({
  getRedisService: jest.fn()
}));

import { Ad } from '@/models/Ad';

const mockFindOne = Ad.findOne as jest.Mock;

describe('brandCanvasService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindOne.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(null)
      })
    });
  });

  it('buildBrandCanvasPayload maps creativeUrl and templateData', () => {
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

  it('buildBrandCanvasPayload falls back to name and creativeUrl', () => {
    const payload = buildBrandCanvasPayload({
      _id: 'ad2',
      userId: 'user1',
      name: 'Logo Board',
      creativeUrl: 'https://cdn.example.com/logo.png',
      templateData: {},
      status: AdStatus.RUNNING,
      updatedAt: new Date().toISOString()
    });
    expect(payload.message).toBe('Logo Board');
    expect(payload.qrText).toBe('https://cdn.example.com/logo.png');
  });

  it('getRunningBrandCanvasAd queries BRAND_CANVAS RUNNING by userId', async () => {
    const lean = jest.fn().mockResolvedValue({
      _id: 'ad1',
      userId: '674a1b2c3d4e5f678901234',
      type: AdType.BRAND_CANVAS,
      status: AdStatus.RUNNING,
      name: 'Test',
      creativeUrl: 'https://cdn.example.com/a.png',
      templateData: {}
    });
    const sort = jest.fn().mockReturnValue({ lean });
    mockFindOne.mockReturnValue({ sort });

    const result = await getRunningBrandCanvasAd('507f1f77bcf86cd799439011');

    expect(mockFindOne).toHaveBeenCalledWith({
      userId: expect.anything(),
      type: AdType.BRAND_CANVAS,
      status: AdStatus.RUNNING
    });
    expect(sort).toHaveBeenCalledWith({ updatedAt: -1 });
    expect(result?.name).toBe('Test');
  });

  it('getRunningBrandCanvasAd returns null for invalid userId', async () => {
    const result = await getRunningBrandCanvasAd('not-an-object-id');
    expect(result).toBeNull();
    expect(mockFindOne).not.toHaveBeenCalled();
  });
});
