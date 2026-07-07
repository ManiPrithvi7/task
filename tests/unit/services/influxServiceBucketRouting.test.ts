import { InfluxDB } from '@influxdata/influxdb-client';
import { InfluxService, BucketTarget } from '@/services/influxService';
import type { InfluxDBConfig } from '@/config';

jest.mock('@influxdata/influxdb-client', () => {
  const mockWriteApi = {
    writePoint: jest.fn(),
    writeRecords: jest.fn(),
    flush: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    useDefaultTags: jest.fn(),
  };
  return {
    InfluxDB: jest.fn().mockImplementation(() => ({
      getWriteApi: jest.fn().mockReturnValue(mockWriteApi),
      getQueryApi: jest.fn().mockReturnValue({
        queryRows: jest.fn(),
      }),
    })),
    Point: jest.fn().mockImplementation(() => ({
      tag: jest.fn().mockReturnThis(),
      stringField: jest.fn().mockReturnThis(),
      intField: jest.fn().mockReturnThis(),
      floatField: jest.fn().mockReturnThis(),
      booleanField: jest.fn().mockReturnThis(),
      timestamp: jest.fn().mockReturnThis(),
      toLineProtocol: jest.fn().mockReturnValue('m,tag=a v=1'),
    })),
    WriteApi: jest.fn(),
    QueryApi: jest.fn(),
  };
});

describe('InfluxService bucket routing', () => {
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

  let service: InfluxService;
  let spySubmitPoint: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new InfluxService(mockConfig);
    spySubmitPoint = jest.spyOn(service as any, 'submitPoint');
  });

  it('routes writeInstagramFetchAudit to metrics bucket', async () => {
    await service.writeInstagramFetchAudit({
      deviceId: 'dev-1',
      userId: 'user-1',
      success: true,
      triggerType: 'poll',
      oldFollowers: 100,
      newFollowers: 101,
      durationMs: 500,
    });
    expect(spySubmitPoint).toHaveBeenCalledWith(
      expect.anything(),
      BucketTarget.METRICS,
      expect.any(Boolean)
    );
  });

  it('routes writeAuditEvent to compliance bucket', async () => {
    await service.writeAuditEvent({
      event: 'OTA_SUCCESS',
      deviceId: 'dev-1',
      hash: 'abc123',
      sequence: 1,
    });
    expect(spySubmitPoint).toHaveBeenCalledWith(
      expect.anything(),
      BucketTarget.COMPLIANCE,
      expect.any(Boolean)
    );
  });

  it('routes writeTransparencyEntry to compliance bucket', async () => {
    await service.writeTransparencyEntry({
      index: 0,
      leafHash: 'leaf',
      rootHash: 'root',
      inclusionProof: '[]',
      certFingerprint: 'fp',
      serialNumber: 'SN1',
      cn: 'device.test',
      deviceId: 'dev-1',
      issuedAt: new Date(),
    });
    expect(spySubmitPoint).toHaveBeenCalledWith(
      expect.anything(),
      BucketTarget.COMPLIANCE,
      expect.any(Boolean)
    );
  });

  it('routes writeSocialMetrics to metrics bucket', async () => {
    await service.writeSocialMetrics('instagram', 'user-1', { followers: 100 });
    expect(spySubmitPoint).toHaveBeenCalledWith(
      expect.anything(),
      BucketTarget.METRICS,
      expect.any(Boolean)
    );
  });

  it('routes writeInstagramFollowersGauge to metrics bucket', async () => {
    await service.writeInstagramFollowersGauge('dev-1', 'ig-1', 100);
    expect(spySubmitPoint).toHaveBeenCalledWith(
      expect.anything(),
      BucketTarget.METRICS,
      expect.any(Boolean)
    );
  });

  it('routes writeRateLimitEvent to metrics bucket', async () => {
    await service.writeRateLimitEvent({
      limitType: 'rate',
      endpoint: '/api/test',
      ip: '127.0.0.1',
      count: 5,
      limit: 100,
    });
    expect(spySubmitPoint).toHaveBeenCalledWith(
      expect.anything(),
      BucketTarget.METRICS,
      expect.any(Boolean)
    );
  });

  it('resolveBucket returns correct bucket names', () => {
    expect((service as any).resolveBucket(BucketTarget.METRICS)).toBe('metrics');
    expect((service as any).resolveBucket(BucketTarget.COMPLIANCE)).toBe('pki_compliance');
  });
});
