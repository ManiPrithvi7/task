import {
  applyInstagramServerlessDeviceOutcome,
  formatInstagramScreenMqttPayload,
  publishInstagramScreenIfChanged,
  registerAttentionCorrelationStart,
  getInstagramPollingMetricsSnapshot,
  type NormalizedDeviceFetchResult
} from '@/services/instagramService';
import { logger } from '@/utils/logger';

const mockRuntime = {
  getFollowers: jest.fn(),
  getLastPub: jest.fn(),
  getLastFollowerCountTimestamp: jest.fn(),
  setFollowers: jest.fn(),
  setLastPub: jest.fn()
};

const mockInflux = {
  writeInstagramFetchAudit: jest.fn().mockResolvedValue(undefined),
  writeIgMetrics: jest.fn().mockResolvedValue(undefined),
  writeProfileBaseline: jest.fn().mockResolvedValue(undefined),
  writeIgMilestone: jest.fn().mockResolvedValue(undefined),
  writeInstagramAttentionE2eLatency: jest.fn().mockResolvedValue(undefined),
  writeMqttDelivery: jest.fn().mockResolvedValue(undefined),
  flushWrites: jest.fn().mockResolvedValue(undefined)
};

jest.mock('mongoose', () => {
  const fake = {
    Types: { ObjectId: jest.fn((id: string) => id) },
    model: jest.fn(() => ({})),
    Schema: jest.fn(() => ({ index: jest.fn() }))
  };
  return { __esModule: true, default: fake, ...fake };
});

jest.mock('@/models/Social', () => ({
  Social: { findOne: jest.fn(), updateOne: jest.fn() },
  Provider: { GOOGLE_BUSINESS: 'GOOGLE_BUSINESS' }
}));

jest.mock('@/models/Device', () => ({
  Device: { findOne: jest.fn() }
}));

jest.mock('@/services/igDeviceRuntimeCache', () => ({
  getIgDeviceRuntimeCache: () => mockRuntime,
  syncScreenFieldImmediate: jest.fn()
}));

jest.mock('@/services/influxService', () => ({
  getInfluxService: () => mockInflux
}));

jest.mock('@/services/deviceService', () => ({
  getActiveDeviceCache: () => ({ getAllActive: jest.fn().mockResolvedValue([{ deviceId: 'd1' }]) })
}));

jest.mock('@/services/redisService', () => ({
  getRedisService: jest.fn()
}));

jest.mock('@/utils/stimulateAllowlist', () => ({
  isStimulateDevice: jest.fn(() => false),
  shouldSkipForStimulate: jest.fn(() => false)
}));

jest.mock('@/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

function makeMqtt() {
  return { publish: jest.fn().mockResolvedValue(undefined) } as never;
}

function successRow(overrides: Record<string, unknown> = {}): NormalizedDeviceFetchResult {
  return {
    deviceId: 'd1',
    success: true,
    fetched_at: '2026-08-01T00:00:00.000Z',
    followers_count: 500,
    instagram_username: 'the_handle',
    instagram_account_id: 'ig-1',
    userId: 'u1',
    api_response_time_ms: 120,
    http_status: 200,
    ...overrides
  } as NormalizedDeviceFetchResult;
}

describe('instagramService outcome applicator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRuntime.getFollowers.mockReturnValue(undefined);
    mockRuntime.getLastPub.mockReturnValue(undefined);
    mockRuntime.getLastFollowerCountTimestamp.mockReturnValue(undefined);
  });

  it('success with no cached followers: audit + metrics + baseline + publish + flush', async () => {
    const mqtt = makeMqtt();
    await applyInstagramServerlessDeviceOutcome(successRow(), mqtt, 'proof', 'scheduled');

    expect(mockInflux.writeInstagramFetchAudit).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'd1', success: true, oldFollowers: null, newFollowers: 500 }),
      { flush: false }
    );
    expect(mockInflux.writeIgMetrics).toHaveBeenCalled();
    expect(mockInflux.writeProfileBaseline).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'd1', followers: 500, platform: 'instagram' }),
      { flush: false }
    );
    expect(mockInflux.flushWrites).toHaveBeenCalled();
    expect(mqtt.publish).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'proof/d1/instagram', qos: 1, retain: true })
    );
  });

  it('success with follower change: writes milestones and updates runtime cache', async () => {
    mockRuntime.getFollowers.mockReturnValue(400);
    mockRuntime.getLastFollowerCountTimestamp.mockReturnValue(Date.now() - 2 * 24 * 3600 * 1000);
    const mqtt = makeMqtt();
    await applyInstagramServerlessDeviceOutcome(successRow(), mqtt, 'proof', 'scheduled');

    expect(mockInflux.writeIgMilestone).toHaveBeenCalledTimes(4);
    expect(mockInflux.writeIgMilestone).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'd1', followersCount: 500, velocity: expect.any(Number) }),
      { flush: false }
    );
    expect(mockRuntime.setFollowers).toHaveBeenCalledWith('d1', 500, expect.any(Number));
  });

  it('success with correlationId: registers e2e latency write', async () => {
    registerAttentionCorrelationStart('corr-1');
    const mqtt = makeMqtt();
    await applyInstagramServerlessDeviceOutcome(successRow(), mqtt, 'proof', 'attention', 'corr-1');
    expect(mockInflux.writeInstagramAttentionE2eLatency).toHaveBeenCalledWith(
      'd1', 'attention', expect.any(Number), expect.any(Date), { flush: false }
    );
  });

  it('failure: no publish, audit carries error, no metrics writes', async () => {
    const mqtt = makeMqtt();
    await applyInstagramServerlessDeviceOutcome(
      successRow({ success: false, error: 'graph api down', http_status: 500 }),
      mqtt,
      'proof',
      'scheduled'
    );
    expect(mockInflux.writeInstagramFetchAudit).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, errorMessage: 'graph api down', errorCode: undefined }),
      { flush: false }
    );
    expect(mockInflux.writeIgMetrics).not.toHaveBeenCalled();
    expect(mqtt.publish).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      '[IG_SCREEN] Skipping MQTT for failed fetch',
      expect.objectContaining({ deviceId: 'd1', error: 'graph api down' })
    );
  });

  it('429 with retry-after: opens circuit and increments circuitOpenEvents', async () => {
    const before = Number(getInstagramPollingMetricsSnapshot().circuitOpenEvents);
    const mqtt = makeMqtt();
    await applyInstagramServerlessDeviceOutcome(
      successRow({ success: false, http_status: 429, retry_after_seconds: 10, error: 'rate limited' }),
      mqtt,
      'proof',
      'scheduled'
    );
    expect(Number(getInstagramPollingMetricsSnapshot().circuitOpenEvents)).toBe(before + 1);
  });

  it('publishInstagramScreenIfChanged skips unchanged followers when heartbeat recent', async () => {
    mockRuntime.getFollowers.mockReturnValue(500);
    mockRuntime.getLastPub.mockReturnValue(Date.now());
    const mqtt = makeMqtt();
    await publishInstagramScreenIfChanged(mqtt, 'proof', {
      deviceId: 'd1',
      success: true,
      fetched_at: '2026-08-01T00:00:00.000Z',
      data: { followers_count: 500 }
    });
    expect(mqtt.publish).not.toHaveBeenCalled();
  });

  it('publishInstagramScreenIfChanged force-publishes heartbeat after 10min silence', async () => {
    mockRuntime.getFollowers.mockReturnValue(500);
    mockRuntime.getLastPub.mockReturnValue(Date.now() - 11 * 60 * 1000);
    const mqtt = makeMqtt();
    await publishInstagramScreenIfChanged(mqtt, 'proof', {
      deviceId: 'd1',
      success: true,
      fetched_at: '2026-08-01T00:00:00.000Z',
      data: { followers_count: 500 }
    });
    expect(mqtt.publish).toHaveBeenCalled();
  });
});

describe('formatInstagramScreenMqttPayload', () => {
  it('builds topic and payload with followers, handle qr text, and correlation passthrough', () => {
    const { topic, payload } = formatInstagramScreenMqttPayload(
      {
        deviceId: 'd1',
        success: true,
        fetched_at: '2026-08-01T00:00:00.000Z',
        data: { followers_count: 1234, instagram_username: '@some_handle' },
        correlation_id: 'corr-9'
      },
      'proof'
    );
    expect(topic).toBe('proof/d1/instagram');
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed.correlation_id).toBe('corr-9');
    expect((parsed.payload as Record<string, unknown>).followers).toBe(1234);
    expect((parsed.payload as Record<string, unknown>).qrText).toContain('instagram.com/some_handle');
  });

  it('defaults empty handle to instagram.com root', () => {
    const { payload } = formatInstagramScreenMqttPayload(
      {
        deviceId: 'd1',
        success: true,
        fetched_at: '2026-08-01T00:00:00.000Z',
        data: { followers_count: 10 }
      },
      'proof'
    );
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect((parsed.payload as Record<string, unknown>).qrText).toBe('https://www.instagram.com/');
  });
});
