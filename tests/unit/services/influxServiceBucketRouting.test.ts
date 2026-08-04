import { InfluxDB } from '@influxdata/influxdb-client';
import { InfluxService, BucketTarget } from '@/services/influxService';
import type { InfluxDBConfig } from '@/config';

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

  it('igMetrics routes to METRICS', async () => {
    const submitSpy = jest.spyOn(service.igMetrics as any, 'submit');
    await service.writeIgMetrics({
      deviceId: 'dev-1',
      igId: 'ig-1',
      trigger: 'api_poll',
      followersCount: 100,
    });
    expect(submitSpy).toHaveBeenCalledWith(
      expect.anything(),
      BucketTarget.METRICS,
      expect.any(Boolean)
    );
  });

  it('instantiates compliance-category repos with compliance WriteApi', async () => {
    const submitSpy = jest.spyOn(service.pkiAudit as any, 'submit');
    await service.writeAuditEvent({
      event: 'OTA_SUCCESS',
      deviceId: 'dev-1',
      hash: 'abc',
      sequence: 1,
      hashPreimage: '{}',
    });
    expect(submitSpy).toHaveBeenCalledWith(
      expect.anything(),
      BucketTarget.COMPLIANCE,
      expect.any(Boolean)
    );
  });

  it('instagramAudit routes to METRICS', async () => {
    const submitSpy = jest.spyOn(service.instagramAudit as any, 'submit');
    await service.writeInstagramFetchAudit({
      deviceId: 'd1',
      userId: 'u1',
      success: true,
      triggerType: 'poll',
      oldFollowers: 100,
      newFollowers: 101,
      durationMs: 500,
    });
    expect(submitSpy).toHaveBeenCalledWith(expect.anything(), BucketTarget.METRICS, expect.any(Boolean));
  });

  it('ctLog routes to COMPLIANCE', async () => {
    const submitSpy = jest.spyOn(service.ctLog as any, 'submit');
    await service.writeTransparencyEntry({
      index: 0,
      leafHash: 'l',
      leafPreimage: 'fp|S1|c|ts',
      rootHash: 'r',
      inclusionProof: '[]',
      certFingerprint: 'fp',
      serialNumber: 'S1',
      cn: 'c',
      deviceId: 'd1',
      issuedAt: new Date(),
    });
    expect(submitSpy).toHaveBeenCalledWith(expect.anything(), BucketTarget.COMPLIANCE, expect.any(Boolean));
  });

  it('deviceStateLog routes to COMPLIANCE', async () => {
    const submitSpy = jest.spyOn(service.deviceStateLog as any, 'submit');
    await service.writeDeviceStateLog({
      deviceId: 'd1',
      event: 'active',
      sequence: 1,
      hash: 'h',
      previousHash: 'GENESIS',
      hashPreimage: '{}',
    });
    expect(submitSpy).toHaveBeenCalledWith(expect.anything(), BucketTarget.COMPLIANCE, expect.any(Boolean));
  });

  it('mqttDelivery routes to METRICS', async () => {
    const submitSpy = jest.spyOn(service.mqttDelivery as any, 'submit');
    await service.writeMqttDelivery({
      platform: 'instagram',
      deviceId: 'd1',
      success: true,
      payloadSizeBytes: 10,
      payloadSha256: 'abc',
    });
    expect(submitSpy).toHaveBeenCalledWith(expect.anything(), BucketTarget.METRICS, expect.any(Boolean));
  });
});
