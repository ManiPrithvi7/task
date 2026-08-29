import { Point } from '@influxdata/influxdb-client';
import { BaseInfluxRepo } from '../BaseInfluxRepo';
import { BucketTarget } from '../types';

export interface DeviceStateLogInput {
  deviceId: string;
  event: 'active' | 'inactive';
  sequence: number;
  hash: string;
  previousHash: string;
  hashPreimage: string;
  fwVersion?: string;
  fwTrack?: string;
  ipHash?: string;
  businessIdAtTime?: string;
  timestamp?: Date;
}

export class DeviceStateLogRepo extends BaseInfluxRepo<DeviceStateLogInput> {
  buildPoint(input: DeviceStateLogInput): Point {
    const point = new Point('device_state_log')
      .tag('device_id', input.deviceId)
      .tag('event', input.event)
      .intField('sequence', input.sequence)
      .stringField('hash', input.hash)
      .stringField('previous_hash', input.previousHash)
      .stringField('hash_preimage', input.hashPreimage);

    if (input.fwVersion) point.stringField('fw_version', input.fwVersion);
    if (input.fwTrack) point.stringField('fw_track', input.fwTrack);
    if (input.ipHash) point.stringField('ip_hash', input.ipHash);
    if (input.businessIdAtTime) point.stringField('business_id_at_time', input.businessIdAtTime);

    point.timestamp(input.timestamp ?? new Date());
    return point;
  }

  async write(input: DeviceStateLogInput): Promise<void> {
    await this.submit(this.buildPoint(input), BucketTarget.COMPLIANCE, true);
  }
}
