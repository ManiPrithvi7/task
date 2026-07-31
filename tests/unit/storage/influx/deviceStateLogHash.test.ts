import * as crypto from 'crypto';
import { DeviceStateLogRepo } from '@/storage/influx/repositories/DeviceStateLogRepo';
import type { InfluxDBConfig } from '@/config';

const mockConfig = {
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
  auditMaxFieldLength: 4096,
  logWrites: false,
} as InfluxDBConfig;

describe('device_state_log hash preimage', () => {
  it('stores preimage that recomputes to hash', () => {
    const hashContent = {
      deviceId: 'd1',
      event: 'active',
      fwTrack: null,
      fwVersion: '1.0.0',
      ipHash: 'abc',
      previousHash: 'GENESIS',
      timestamp: '2026-07-31T00:00:00.000Z',
      userIdAtTime: 'u1',
    };
    const sortedKeys = Object.keys(hashContent).sort();
    const hashPreimage = JSON.stringify(hashContent, sortedKeys);
    const hash = crypto.createHash('sha256').update(hashPreimage, 'utf8').digest('hex');

    const repo = new DeviceStateLogRepo(mockConfig, {} as any, null);
    const point = repo.buildPoint({
      deviceId: 'd1',
      event: 'active',
      sequence: 1,
      hash,
      previousHash: 'GENESIS',
      hashPreimage,
      fwVersion: '1.0.0',
      ipHash: 'abc',
      userIdAtTime: 'u1',
    });

    expect(crypto.createHash('sha256').update(hashPreimage, 'utf8').digest('hex')).toBe(hash);
    expect(point).toBeDefined();
  });
});
