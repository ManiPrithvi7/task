import { InfluxService } from '@/services/influxService';
import type { InfluxDBConfig } from '@/config';

const mockHttpGet = jest.fn();

jest.mock('@/utils/httpProbe', () => ({
  httpGet: (...args: unknown[]) => mockHttpGet(...args)
}));

const mockConfig: InfluxDBConfig = {
  url: 'http://localhost:8086',
  token: 'test-token',
  org: 'test-org',
  bucket: 'metrics',
  complianceBucket: 'pki_compliance',
  diskQueueEnabled: false,
  diskQueueSyncOnAppend: false,
  diskQueuePath: '/tmp/influx-queue.lines',
  diskQueueFlushMs: 1000,
  diskQueueBatchMax: 500,
  diskQueueMaxLinesPerFile: 100000,
  clientBatchSize: 500,
  clientFlushIntervalMs: 1000,
  auditMaxFieldLength: 4096,
  logWrites: false,
};

const ENV_KEYS = [
  'INFLUXDB_HEALTH_RETRIES',
  'INFLUXDB_HEALTH_RETRY_DELAY_MS',
  'INFLUXDB_HEALTH_TIMEOUT_MS',
  'INFLUXDB_API_PROBE_TIMEOUT_MS',
  'INFLUXDB_FLUX_PROBE_TIMEOUT_MS'
] as const;

function withEnv(env: Record<string, string>, fn: () => Promise<void>) {
  return async () => {
    const saved = new Map<string, string | undefined>();
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      if (key in env) process.env[key] = env[key];
      else delete process.env[key];
    }
    try {
      await fn();
    } finally {
      for (const key of ENV_KEYS) process.env[key] = saved.get(key);
    }
  };
}

function healthyBuckets() {
  return {
    statusCode: 200,
    json: { buckets: [{ name: 'metrics' }, { name: 'pki_compliance' }] }
  };
}

describe('InfluxService.healthCheck', () => {
  let service: InfluxService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new InfluxService(mockConfig);
    mockHttpGet.mockImplementation((url: string) =>
      url.includes('/health')
        ? { statusCode: 200, json: {} }
        : healthyBuckets()
    );
  });

  it('loopback: probes /health with loopback timeouts, verifies both buckets, returns true', withEnv({}, async () => {
    expect(await service.healthCheck()).toBe(true);
    expect(mockHttpGet).toHaveBeenCalledWith('http://localhost:8086/health', { timeout: 3000 });
    expect(mockHttpGet).toHaveBeenCalledWith(
      'http://localhost:8086/api/v2/buckets?org=test-org',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Token test-token' }) })
    );
  }));

  it('accepts payload status "pass"', withEnv({}, async () => {
    mockHttpGet.mockImplementation((url: string) =>
      url.includes('/health')
        ? { statusCode: 200, json: { status: 'pass' } }
        : healthyBuckets()
    );
    expect(await service.healthCheck()).toBe(true);
  }));

  it('returns false when /health payload status is not pass', withEnv({}, async () => {
    mockHttpGet.mockImplementation((url: string) =>
      url.includes('/health')
        ? { statusCode: 200, json: { status: 'fail', message: 'downstream broken' } }
        : healthyBuckets()
    );
    expect(await service.healthCheck()).toBe(false);
  }));

  it('returns false immediately on non-retryable HTTP error (404)', withEnv({}, async () => {
    mockHttpGet.mockImplementation((url: string) =>
      url.includes('/health') ? { statusCode: 404, json: {} } : healthyBuckets()
    );
    expect(await service.healthCheck()).toBe(false);
  }));

  it('returns false when retryable 503 exhausts maxAttempts=1 (env override)', withEnv({ INFLUXDB_HEALTH_RETRIES: '1' }, async () => {
    mockHttpGet.mockImplementation((url: string) =>
      url.includes('/health') ? { statusCode: 503, json: {} } : healthyBuckets()
    );
    expect(await service.healthCheck()).toBe(false);
  }));

  it('retries 500s and succeeds with "OK after retry" log', withEnv({ INFLUXDB_HEALTH_RETRIES: '3', INFLUXDB_HEALTH_RETRY_DELAY_MS: '0' }, async () => {
    let healthCalls = 0;
    mockHttpGet.mockImplementation((url: string) => {
      if (url.includes('/health')) {
        healthCalls += 1;
        return healthCalls < 3 ? { statusCode: 500, json: {} } : { statusCode: 200, json: { status: 'pass' } };
      }
      return healthyBuckets();
    });
    expect(await service.healthCheck()).toBe(true);
    expect(healthCalls).toBe(3);
  }));

  it('returns false when /health keeps throwing', withEnv({ INFLUXDB_HEALTH_RETRIES: '1' }, async () => {
    mockHttpGet.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await service.healthCheck()).toBe(false);
  }));

  it('rejects invalid token via 401 on buckets API', withEnv({}, async () => {
    mockHttpGet.mockImplementation((url: string) =>
      url.includes('/health') ? { statusCode: 200, json: {} } : { statusCode: 401, json: {} }
    );
    expect(await service.healthCheck()).toBe(false);
  }));

  it('returns false when metrics bucket missing from listing', withEnv({}, async () => {
    mockHttpGet.mockImplementation((url: string) =>
      url.includes('/health')
        ? { statusCode: 200, json: {} }
        : { statusCode: 200, json: { buckets: [{ name: 'other' }] } }
    );
    expect(await service.healthCheck()).toBe(false);
  }));

  it('recovers from transient buckets API 500', withEnv({ INFLUXDB_HEALTH_RETRIES: '2', INFLUXDB_HEALTH_RETRY_DELAY_MS: '0' }, async () => {
    let bucketCalls = 0;
    mockHttpGet.mockImplementation((url: string) => {
      if (url.includes('/health')) return { statusCode: 200, json: {} };
      bucketCalls += 1;
      return bucketCalls === 1 ? { statusCode: 500, json: {} } : healthyBuckets();
    });
    expect(await service.healthCheck()).toBe(true);
  }));

  it('non-loopback host: no hostname rewrite, default timeouts applied', withEnv({ INFLUXDB_HEALTH_RETRIES: '1' }, async () => {
    const s = new InfluxService({ ...mockConfig, url: 'https://influx.example.com' });
    expect(await s.healthCheck()).toBe(true);
    expect(mockHttpGet).toHaveBeenCalledWith('https://influx.example.com/health', { timeout: 20000 });
  }));
});
