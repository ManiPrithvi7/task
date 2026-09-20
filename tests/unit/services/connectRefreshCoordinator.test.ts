import { ConnectRefreshCoordinator } from '@/services/connectRefreshCoordinator';

const mockGetActive = jest.fn();
const mockGetUserIntegrations = jest.fn();
const mockCacheUserIntegrations = jest.fn();
const mockClearHashes = jest.fn();
const mockShouldSkip = jest.fn();
const mockSetIgNoCredentials = jest.fn();

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

jest.mock('@/services/igDeviceRuntimeCache', () => ({
  getIgDeviceRuntimeCache: () => ({ setIgNoCredentials: mockSetIgNoCredentials })
}));

function makeDeps(overrides: Record<string, unknown> = {}) {
  const publishForDevice = jest.fn().mockResolvedValue(undefined);
  const markPriority = jest.fn().mockResolvedValue(undefined);
  const requestImmediateFetch = jest.fn().mockResolvedValue(undefined);
  const waitUntilConnected = jest.fn().mockResolvedValue(true);
  const getTopicRoot = jest.fn().mockReturnValue('proof');
  const publish = jest.fn().mockResolvedValue(undefined);
  const isRedisConnected = jest.fn().mockReturnValue(false);

  return {
    mqttClient: { getTopicRoot, waitUntilConnected, publish },
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
      publish,
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

describe('ConnectRefreshCoordinator.publishDisconnected', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockShouldSkip.mockResolvedValue(false);
    mockClearHashes.mockResolvedValue(1);
  });

  it('publishes a zeroed Instagram screen and clears hashes', async () => {
    const deps = makeDeps();
    const coord = new ConnectRefreshCoordinator(deps as never);
    await coord.publishDisconnected('d1', 'INSTAGRAM' as never);

    expect(mockClearHashes).toHaveBeenCalledWith('d1');
    expect(deps._spies.publish).toHaveBeenCalledTimes(1);
    const call = deps._spies.publish.mock.calls[0][0] as {
      topic: string;
      payload: string;
      qos: number;
      retain: boolean;
    };
    expect(call.topic).toBe('proof/d1/instagram');
    expect(call.qos).toBe(1);
    expect(call.retain).toBe(false);
    const body = JSON.parse(call.payload) as { payload: { followers: number } };
    expect(body.payload.followers).toBe(0);
  });

  it('publishes a zeroed GMB screen', async () => {
    const deps = makeDeps();
    const coord = new ConnectRefreshCoordinator(deps as never);
    await coord.publishDisconnected('d1', 'GOOGLE_BUSINESS' as never);

    const call = deps._spies.publish.mock.calls[0][0] as {
      topic: string;
      payload: string;
    };
    expect(call.topic).toBe('proof/d1/gmb');
    const body = JSON.parse(call.payload) as { payload: { verifiedReview: number } };
    expect(body.payload.verifiedReview).toBe(0);
  });

  it('onStatusChanged disconnect goes to zeroed publish, connect goes to refresh', async () => {
    mockGetActive.mockResolvedValue({ deviceId: 'd1', businessId: 'u1' });
    mockGetUserIntegrations.mockResolvedValue({ instagram: { id: 'ig' } });
    const deps = makeDeps();
    const coord = new ConnectRefreshCoordinator(deps as never);

    await coord.onStatusChanged('d1', { provider: 'INSTAGRAM' as never, action: 'disconnect' });
    expect(deps._spies.publish).toHaveBeenCalled();
    expect(deps._spies.requestImmediateFetch).not.toHaveBeenCalled();

    deps._spies.publish.mockClear();
    await coord.onStatusChanged('d1', { provider: 'INSTAGRAM' as never, action: 'connect' });
    expect(deps._spies.requestImmediateFetch).toHaveBeenCalledWith('d1', { trigger: 'connect' });
  });

  it('skips MQTT when stim allowlist says so', async () => {
    mockShouldSkip.mockResolvedValue(true);
    const deps = makeDeps();
    const coord = new ConnectRefreshCoordinator(deps as never);
    await coord.publishDisconnected('d1', 'INSTAGRAM' as never);
    expect(deps._spies.publish).not.toHaveBeenCalled();
  });
});
