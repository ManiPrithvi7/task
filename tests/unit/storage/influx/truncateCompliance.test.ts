import { PkiAuditRepo } from '@/storage/influx/repositories/PkiAuditRepo';
import { MqttDeliveryRepo } from '@/storage/influx/repositories/MqttDeliveryRepo';
import { BucketTarget } from '@/storage/influx/types';
import type { InfluxDBConfig } from '@/config';

const mockConfig: InfluxDBConfig = {
  dataDir: '/tmp/influx-test-data',
  url: 'http://localhost:8086',
  token: 't',
  org: 'o',
  bucket: 'metrics',
  complianceBucket: 'pki_compliance',
  diskQueueEnabled: false,
  diskQueueSyncOnAppend: false,
  diskQueuePath: '/tmp/q',
  diskQueueFlushMs: 1000,
  diskQueueBatchMax: 500,
  diskQueueMaxLinesPerFile: 100000,
  clientBatchSize: 500,
  clientFlushIntervalMs: 1000,
  auditMaxFieldLength: 20,
  logWrites: false,
};

describe('truncate compliance skip', () => {
  it('does not truncate pki_audit details (compliance)', () => {
    const repo = new PkiAuditRepo(mockConfig, {} as any, null);
    const long = 'x'.repeat(100);
    const point = repo.buildPoint({
      event: 'TEST',
      deviceId: 'system',
      details: { msg: long },
      hashPreimage: '{}',
    });
    // Point mock may not expose fields; assert via truncate directly
    expect((repo as any).truncate(long, BucketTarget.COMPLIANCE)).toBe(long);
  });

  it('truncates metrics error_message', () => {
    const repo = new MqttDeliveryRepo(mockConfig, {} as any, null);
    const long = 'y'.repeat(100);
    const truncated = (repo as any).truncate(long, BucketTarget.METRICS);
    expect(truncated.length).toBeLessThanOrEqual(20);
    expect(truncated.endsWith('...')).toBe(true);
  });
});
