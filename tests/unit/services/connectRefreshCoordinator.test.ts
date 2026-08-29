import { ConnectRefreshCoordinator } from '@/services/connectRefreshCoordinator';

const mockGetActive = jest.fn();
const mockGetUserIntegrations = jest.fn();
const mockCacheUserIntegrations = jest.fn();
const mockClearHashes = jest.fn();
const mockShouldSkip = jest.fn();

jest.mock('@/services/deviceService', () => ({
  getActiveDeviceCache: () => ({ getActive: mockGetActive })
}));

jest.mock('@/services/userIntegrationCache', () => ({
  getUserIntegrations: (...args: unknown[]) => mockGetUserIntegrations(...args),
  cacheUserIntegrations: (...args: unknown[]) => mockCacheUserIntegrations(...args)
}));

jest.mock('@/services/mqttChangeDetection', () => ({
  clearAllPublishHashesForDevice: (...args: unknown[]) => mockClearHashes(...args)
}));

jest.mock('@/utils/stimulateAllowlist', () => ({
  shouldSkipForStimulate: (...args: unknown[]) => mockShouldSkip(...args)
}));

function makeDeps(overrides: Record<string, unknown> = {}) {
  const publishForDevice = jest.fn().mockResolvedValue(undefined);
  const markPriority = jest.fn().mockResolvedValue(undefined);
  const requestImmediateFetch = jest.fn().mockResolvedValue(undefined);
  const waitUntilConnected = jest.fn().mockResolvedValue(true);
  const getTopicRoot = jest.fn().mockReturnValue('proof');
  const isRedisConnected = jest.fn().mockReturnValue(false);

  return {
    mqttClient: { getTopicRoot, waitUntilConnected },
    redisService: { isRedisConnected },
    instagramPoller: { markPriority, requestImmediateFetch },
    instagramPriorityTtlMs: 60_000,
    gmbConnectPull: { publishForDevice },
    ...overrides,
    _spies: {
      publishForDevice,
      markPriority,
      requestImmediateFetch,
      waitUntilConnected,
      clearHashes: mockClearHashes
    }
  };
}

describe('ConnectRefreshCoordinator.refresh', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockShouldSkip.mockResolvedValue(false);
    mockClearHashes.mockResolvedValue(3);
  });

  it('returns early when active device has no businessId', async () => {
    mockGetActive.mockResolvedValue({ deviceId: 'd1' });
    const deps = makeDeps();
    const coord = new ConnectRefreshCoordinator(deps as never);
    await coord.refresh('d1');
    expect(mockGetUserIntegrations).not.toHaveBeenCalled();
    expect(mockClearHashes).not.toHaveBeenCalled();
  });

  it('clears hashes and runs screen pulls for linked integrations', async () => {
    mockGetActive.mockResolvedValue({ deviceId: 'd1', businessId: 'u1' });
    mockGetUserIntegrations.mockResolvedValue({
      instagram: { id: 'ig' },
      gmb: { locationId: 'loc' }
    });
    const deps = makeDeps();
    const coord = new ConnectRefreshCoordinator(deps as never);

    await coord.refresh('d1');

    expect(mockGetUserIntegrations).toHaveBeenCalledWith('u1');
    expect(mockClearHashes).toHaveBeenCalledWith('d1');
    expect(deps._spies.requestImmediateFetch).toHaveBeenCalledWith('d1', { trigger: 'connect' });
    expect(deps._spies.publishForDevice).toHaveBeenCalledWith('d1', 'proof');
  });

  it('no integrations: warms cache, clears hashes, skips pulls', async () => {
    mockGetActive.mockResolvedValue({ deviceId: 'd1', businessId: 'u1' });
    mockGetUserIntegrations.mockResolvedValue(null);
    mockCacheUserIntegrations.mockResolvedValue(null);
    const deps = makeDeps();
    const coord = new ConnectRefreshCoordinator(deps as never);

    await coord.refresh('d1');

    expect(mockCacheUserIntegrations).toHaveBeenCalledWith('u1');
    expect(mockClearHashes).toHaveBeenCalledWith('d1');
    expect(deps._spies.requestImmediateFetch).not.toHaveBeenCalled();
    expect(deps._spies.publishForDevice).not.toHaveBeenCalled();
  });

  it('skips Instagram pull when poller is absent', async () => {
    mockGetActive.mockResolvedValue({ deviceId: 'd1', businessId: 'u1' });
    mockGetUserIntegrations.mockResolvedValue({ instagram: { id: 'ig' } });
    const deps = makeDeps({ instagramPoller: null });
    const coord = new ConnectRefreshCoordinator(deps as never);

    await coord.refresh('d1');

    expect(deps._spies.requestImmediateFetch).not.toHaveBeenCalled();
    expect(deps._spies.publishForDevice).not.toHaveBeenCalled();
  });
});
