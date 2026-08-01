import { ConnectRefreshCoordinator } from '@/services/connectRefreshCoordinator';
import { resetLocalCachesForTests } from '@/services/localCaches';

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
  const publishPromotionForDevice = jest.fn().mockResolvedValue(undefined);
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
    statsPublisher: { publishPromotionForDevice },
    ...overrides,
    _spies: {
      publishPromotionForDevice,
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
    resetLocalCachesForTests();
    jest.clearAllMocks();
    mockShouldSkip.mockResolvedValue(false);
    mockClearHashes.mockResolvedValue(3);
  });

  it('returns early when active device has no userId', async () => {
    mockGetActive.mockResolvedValue({ deviceId: 'd1' });
    const deps = makeDeps();
    const coord = new ConnectRefreshCoordinator(deps as never);
    await coord.refresh('d1');
    expect(mockGetUserIntegrations).not.toHaveBeenCalled();
    expect(deps._spies.publishPromotionForDevice).not.toHaveBeenCalled();
  });

  it('clears hashes and force-publishes promotion when not debounced', async () => {
    mockGetActive.mockResolvedValue({ deviceId: 'd1', userId: 'u1' });
    mockGetUserIntegrations.mockResolvedValue({ instagram: null, gmb: null });
    const deps = makeDeps();
    const coord = new ConnectRefreshCoordinator(deps as never);

    await coord.refresh('d1');

    expect(mockClearHashes).toHaveBeenCalledWith('d1');
    expect(deps._spies.publishPromotionForDevice).toHaveBeenCalledWith('d1', 'proof', { force: true });
  });

  it('skips hash clear and promotion when debounced; still runs screen pulls', async () => {
    mockGetActive.mockResolvedValue({ deviceId: 'd1', userId: 'u1' });
    mockGetUserIntegrations.mockResolvedValue({
      instagram: { id: 'ig' },
      gmb: { locationId: 'loc' }
    });
    const deps = makeDeps();
    const coord = new ConnectRefreshCoordinator(deps as never);

    // First call marks debounce
    await coord.refresh('d1');
    jest.clearAllMocks();
    mockGetActive.mockResolvedValue({ deviceId: 'd1', userId: 'u1' });
    mockGetUserIntegrations.mockResolvedValue({
      instagram: { id: 'ig' },
      gmb: { locationId: 'loc' }
    });
    mockShouldSkip.mockResolvedValue(false);

    await coord.refresh('d1');

    expect(mockClearHashes).not.toHaveBeenCalled();
    expect(deps._spies.publishPromotionForDevice).not.toHaveBeenCalled();
    expect(deps._spies.requestImmediateFetch).toHaveBeenCalledWith('d1', { trigger: 'connect' });
    expect(deps._spies.publishForDevice).toHaveBeenCalledWith('d1', 'proof');
  });

  it('no-integrations: publishes promotion only when not debounced', async () => {
    mockGetActive.mockResolvedValue({ deviceId: 'd1', userId: 'u1' });
    mockGetUserIntegrations.mockResolvedValue(null);
    mockCacheUserIntegrations.mockResolvedValue(null);
    const deps = makeDeps();
    const coord = new ConnectRefreshCoordinator(deps as never);

    await coord.refresh('d1');
    expect(mockCacheUserIntegrations).toHaveBeenCalledWith('u1');
    expect(deps._spies.publishPromotionForDevice).toHaveBeenCalledWith('d1', 'proof', { force: true });
    expect(deps._spies.requestImmediateFetch).not.toHaveBeenCalled();
    expect(deps._spies.publishForDevice).not.toHaveBeenCalled();
  });

  it('no-integrations + debounced: skips promotion publish', async () => {
    mockGetActive.mockResolvedValue({ deviceId: 'd1', userId: 'u1' });
    mockGetUserIntegrations.mockResolvedValue({ instagram: null, gmb: null });
    const deps = makeDeps();
    const coord = new ConnectRefreshCoordinator(deps as never);
    await coord.refresh('d1'); // arm debounce

    jest.clearAllMocks();
    mockGetActive.mockResolvedValue({ deviceId: 'd1', userId: 'u1' });
    mockGetUserIntegrations.mockResolvedValue(null);
    mockCacheUserIntegrations.mockResolvedValue(null);

    await coord.refresh('d1');
    expect(deps._spies.publishPromotionForDevice).not.toHaveBeenCalled();
    expect(mockClearHashes).not.toHaveBeenCalled();
  });
});
