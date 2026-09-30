import { ConnectRefreshCoordinator } from '@/services/connectRefreshCoordinator';
import { getScreenLiveHub, resetScreenLiveHubForTests } from '@/services/screenLiveHub';

const mockGetActive = jest.fn();
const mockGetUserIntegrations = jest.fn();
const mockCacheUserIntegrations = jest.fn();
const mockClearHashes = jest.fn();
const mockShouldSkip = jest.fn();
const mockSetIgNoCredentials = jest.fn();
const mockClearFollowerCount = jest.fn();
const mockClearGmbReviewCount = jest.fn();
const mockClearDeviceHashFields = jest.fn();
const mockGetBusinessId = jest.fn();
const mockHasInstagramCredentials = jest.fn();

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
  getIgDeviceRuntimeCache: () => ({
    setIgNoCredentials: mockSetIgNoCredentials,
    clearFollowerCount: mockClearFollowerCount,
    clearGmbReviewCount: mockClearGmbReviewCount,
    getBusinessId: mockGetBusinessId,
    hasInstagramCredentials: mockHasInstagramCredentials
  }),
  clearDeviceHashFields: (...args: unknown[]) => mockClearDeviceHashFields(...args),
  IG_STIM_POLLUTION_HASH_FIELDS: ['ig_follower_count', 'ig_followers_origin'],
  GMB_STIM_POLLUTION_HASH_FIELDS: ['gmb_review_count', 'gmb_reviews_origin']
}));

function makeDeps(overrides: Record<string, unknown> = {}) {
  const publishForDevice = jest.fn().mockResolvedValue(undefined);
  const markPriority = jest.fn().mockResolvedValue(undefined);
  const requestImmediateFetch = jest.fn().mockResolvedValue(undefined);
  const startConnectBurst = jest.fn().mockResolvedValue(undefined);
  const waitUntilConnected = jest.fn().mockResolvedValue(true);
  const getTopicRoot = jest.fn().mockReturnValue('proof');
  const publish = jest.fn().mockResolvedValue(undefined);
  const isRedisConnected = jest.fn().mockReturnValue(false);

  return {
    mqttClient: { getTopicRoot, waitUntilConnected, publish },
    redisService: { isRedisConnected },
    instagramPoller: { markPriority, requestImmediateFetch, startConnectBurst },
    instagramPriorityTtlMs: 60_000,
    gmbConnectPull: { publishForDevice },
    ...overrides,
    _spies: {
      publishForDevice,
      markPriority,
      requestImmediateFetch,
      startConnectBurst,
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
    mockClearDeviceHashFields.mockResolvedValue(undefined);
    mockGetBusinessId.mockReturnValue(undefined);
    mockHasInstagramCredentials.mockReturnValue(false);
  });

  it('returns early when active device has no businessId', async () => {
    mockGetActive.mockResolvedValue({ deviceId: 'd1' });
    const deps = makeDeps();
    const coord = new ConnectRefreshCoordinator(deps as never);
    await coord.refresh('d1');
    expect(mockGetUserIntegrations).not.toHaveBeenCalled();
    expect(mockClearHashes).not.toHaveBeenCalled();
  });

  it('uses the cached owner when Mongo businessId is missing and starts the burst', async () => {
    mockGetActive.mockResolvedValue({ deviceId: '274968B43A1D' });
    mockGetBusinessId.mockReturnValue('u-cached');
    mockGetUserIntegrations.mockResolvedValue({ instagram: { id: 'ig' } });
    const deps = makeDeps();
    const coord = new ConnectRefreshCoordinator(deps as never);

    await coord.refresh('274968B43A1D');

    expect(mockGetUserIntegrations).toHaveBeenCalledWith('u-cached');
    expect(deps._spies.startConnectBurst).toHaveBeenCalledWith('274968B43A1D');
  });

  it('starts the burst from cached Instagram credentials when no owner id exists', async () => {
    mockGetActive.mockResolvedValue({ deviceId: '274968B43A1D' });
    mockHasInstagramCredentials.mockReturnValue(true);
    const deps = makeDeps();
    const coord = new ConnectRefreshCoordinator(deps as never);

    await coord.refresh('274968B43A1D');

    expect(mockGetUserIntegrations).not.toHaveBeenCalled();
    expect(deps._spies.startConnectBurst).toHaveBeenCalledWith('274968B43A1D');
  });

  it('clears hashes and runs screen pulls for linked integrations', async () => {
    mockGetActive.mockResolvedValue({ deviceId: 'd1', businessId: 'u1' });
    mockGetUserIntegrations.mockResolvedValue({
      instagram: { id: 'ig' },
      gmb: { locationId: 'loc' }
    });
    const deps = makeDeps();
    (deps.redisService.isRedisConnected as jest.Mock).mockReturnValue(true);
    const coord = new ConnectRefreshCoordinator(deps as never);

    await coord.refresh('d1');

    expect(mockGetUserIntegrations).toHaveBeenCalledWith('u1');
    expect(mockClearHashes).toHaveBeenCalledWith('d1');
    expect(deps._spies.markPriority).toHaveBeenCalledWith('d1', 60_000);
    expect(deps._spies.requestImmediateFetch).toHaveBeenCalledWith('d1', { trigger: 'connect' });
    expect(deps._spies.startConnectBurst).not.toHaveBeenCalled();
    expect(deps._spies.publishForDevice).toHaveBeenCalledWith('d1', 'proof');
  });

  it('starts a 10s connect burst for the allowlisted device instead of a single fetch', async () => {
    mockGetActive.mockResolvedValue({ deviceId: '274968B43A1D', businessId: 'u1' });
    mockGetUserIntegrations.mockResolvedValue({ instagram: { id: 'ig' } });
    const deps = makeDeps();
    (deps.redisService.isRedisConnected as jest.Mock).mockReturnValue(true);
    const coord = new ConnectRefreshCoordinator(deps as never);

    await coord.refresh('274968B43A1D');

    expect(deps._spies.startConnectBurst).toHaveBeenCalledWith('274968B43A1D');
    expect(deps._spies.requestImmediateFetch).not.toHaveBeenCalled();
    expect(deps._spies.markPriority).not.toHaveBeenCalled();
  });

  it('no integrations: warms cache, clears hashes, publishes retain:true zeros', async () => {
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
    expect(deps._spies.publish).toHaveBeenCalledTimes(2);
    const topics = deps._spies.publish.mock.calls.map(
      (c: unknown[]) => (c[0] as { topic: string; retain: boolean }).topic
    );
    expect(topics).toContain('proof/d1/instagram');
    expect(topics).toContain('proof/d1/gmb');
    expect(
      deps._spies.publish.mock.calls.every((c: unknown[]) => (c[0] as { retain: boolean }).retain === true)
    ).toBe(true);
  });

  it('starts the burst from the device hash when user integrations have no Instagram', async () => {
    mockGetActive.mockResolvedValue({
      deviceId: '274968B43A1D',
      businessId: 'u1',
      instagramAccountId: '17841415149243143',
      accessToken: 'token'
    });
    mockGetUserIntegrations.mockResolvedValue({});
    mockHasInstagramCredentials.mockReturnValue(true);
    const deps = makeDeps();
    const coord = new ConnectRefreshCoordinator(deps as never);

    await coord.refresh('274968B43A1D');

    expect(deps._spies.startConnectBurst).toHaveBeenCalledWith('274968B43A1D');
    expect(mockSetIgNoCredentials).toHaveBeenCalledWith('274968B43A1D', false);
    const topics = deps._spies.publish.mock.calls.map(
      (c: unknown[]) => (c[0] as { topic: string }).topic
    );
    expect(topics).not.toContain('proof/274968B43A1D/instagram');
  });

  it('hasInstagram false: publishes zeroed IG retain:true and skips IG pull', async () => {
    mockGetActive.mockResolvedValue({ deviceId: 'd1', businessId: 'u1' });
    mockGetUserIntegrations.mockResolvedValue({ gmb: { locationId: 'loc' } });
    const deps = makeDeps();
    const coord = new ConnectRefreshCoordinator(deps as never);

    await coord.refresh('d1');

    expect(mockSetIgNoCredentials).toHaveBeenCalledWith('d1', true);
    expect(deps._spies.requestImmediateFetch).not.toHaveBeenCalled();
    expect(deps._spies.publishForDevice).toHaveBeenCalledWith('d1', 'proof');
    const igCall = deps._spies.publish.mock.calls.find(
      (c: unknown[]) => (c[0] as { topic: string }).topic === 'proof/d1/instagram'
    );
    expect(igCall).toBeTruthy();
    expect((igCall![0] as { retain: boolean }).retain).toBe(true);
    const body = JSON.parse((igCall![0] as { payload: string }).payload) as {
      payload: { followers: number };
    };
    expect(body.payload.followers).toBe(0);
  });

  it('skips Instagram pull when poller is absent', async () => {
    mockGetActive.mockResolvedValue({ deviceId: 'd1', businessId: 'u1' });
    mockGetUserIntegrations.mockResolvedValue({ instagram: { id: 'ig' } });
    const deps = makeDeps({ instagramPoller: null });
    const coord = new ConnectRefreshCoordinator(deps as never);

    await coord.refresh('d1');

    expect(deps._spies.requestImmediateFetch).not.toHaveBeenCalled();
  });
});

describe('ConnectRefreshCoordinator.publishDisconnected', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockShouldSkip.mockResolvedValue(false);
    mockClearHashes.mockResolvedValue(1);
    mockClearDeviceHashFields.mockResolvedValue(undefined);
  });

  it('publishes a zeroed Instagram screen with retain:true and clears hashes', async () => {
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
    expect(call.retain).toBe(true);
    const body = JSON.parse(call.payload) as { payload: { followers: number } };
    expect(body.payload.followers).toBe(0);
  });

  it('passes a zeroed follower count to a mock screen socket', async () => {
    resetScreenLiveHubForTests();
    const sent: string[] = [];
    const deviceId = '274968B43A1D';
    getScreenLiveHub().accept(
      {
        deviceId,
        allowlisted: true,
        burstFinished: false,
        userId: 'biz-1',
        businessId: 'biz-1',
        followers: 5
      },
      { send: (data) => sent.push(data), close: () => undefined }
    );

    const deps = makeDeps();
    const coord = new ConnectRefreshCoordinator(deps as never);
    await coord.publishDisconnected(deviceId, 'INSTAGRAM' as never);

    const frames = sent.map((line) => JSON.parse(line) as { event: string; followers?: number });
    expect(frames.at(-1)).toMatchObject({ event: 'screen.count', followers: 0 });
    resetScreenLiveHubForTests();
  });

  it('publishes a zeroed GMB screen', async () => {
    const deps = makeDeps();
    const coord = new ConnectRefreshCoordinator(deps as never);
    await coord.publishDisconnected('d1', 'GOOGLE_BUSINESS' as never);

    const call = deps._spies.publish.mock.calls[0][0] as {
      topic: string;
      payload: string;
      retain: boolean;
    };
    expect(call.topic).toBe('proof/d1/gmb');
    expect(call.retain).toBe(true);
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
