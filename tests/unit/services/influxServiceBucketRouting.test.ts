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

  beforeEach(() => {
    jest.clearAllMocks();
    service = new InfluxService(mockConfig);
  });

  it('resolveBucket returns correct bucket names', () => {
    expect((service as any).resolveBucket(BucketTarget.METRICS)).toBe('metrics');
    expect((service as any).resolveBucket(BucketTarget.COMPLIANCE)).toBe('pki_compliance');
  });

  it('instantiates metrics-category repos with metrics WriteApi', () => {
    const submitSpy = jest.spyOn(service.deviceMetrics as any, 'submit');
    service.writeDeviceMetrics('dev-1', { temperature: 22.5 });
    expect(submitSpy).toHaveBeenCalledWith(
      expect.anything(),
      BucketTarget.METRICS,
      expect.any(Boolean)
    );
  });

  it('instantiates compliance-category repos with compliance WriteApi', () => {
    const submitSpy = jest.spyOn(service.pkiAudit as any, 'submit');
    service.writeAuditEvent({ event: 'OTA_SUCCESS', deviceId: 'dev-1', hash: 'abc', sequence: 1 });
    expect(submitSpy).toHaveBeenCalledWith(
      expect.anything(),
      BucketTarget.COMPLIANCE,
      expect.any(Boolean)
    );
  });

  it('instagramAudit routes to METRICS', () => {
    const submitSpy = jest.spyOn(service.instagramAudit as any, 'submit');
    service.writeInstagramFetchAudit({ deviceId: 'd1', userId: 'u1', success: true, triggerType: 'poll', oldFollowers: 100, newFollowers: 101, durationMs: 500 });
    expect(submitSpy).toHaveBeenCalledWith(expect.anything(), BucketTarget.METRICS, expect.any(Boolean));
  });

  it('ctLog routes to COMPLIANCE', () => {
    const submitSpy = jest.spyOn(service.ctLog as any, 'submit');
    service.writeTransparencyEntry({ index: 0, leafHash: 'l', rootHash: 'r', inclusionProof: '[]', certFingerprint: 'fp', serialNumber: 'S1', cn: 'c', deviceId: 'd1', issuedAt: new Date() });
    expect(submitSpy).toHaveBeenCalledWith(expect.anything(), BucketTarget.COMPLIANCE, expect.any(Boolean));
  });

  it('writeSocialMetrics routes to METRICS via deviceMetrics repo', () => {
    const submitSpy = jest.spyOn(service.deviceMetrics as any, 'submit');
    service.writeSocialMetrics('instagram', 'u1', { followers: 100 });
    expect(submitSpy).toHaveBeenCalledWith(expect.anything(), BucketTarget.METRICS, expect.any(Boolean));
  });

  it('writeInstagramFollowersGauge routes to METRICS', () => {
    const submitSpy = jest.spyOn(service.instagramAudit as any, 'submit');
    service.writeInstagramFollowersGauge('d1', 'ig-1', 100);
    expect(submitSpy).toHaveBeenCalledWith(expect.anything(), BucketTarget.METRICS, expect.any(Boolean));
  });
});
