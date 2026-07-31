import { Point } from '@influxdata/influxdb-client';
import { BaseInfluxRepo } from '../BaseInfluxRepo';
import { BucketTarget } from '../types';

export interface DeviceActiveInput {
  deviceId: string;
  status: 'active' | 'inactive';
  fwVersion?: string;
  fwTrack?: string;
  ipHash?: string;
  reason: string;
  userIdAtTime?: string;
  timestamp?: Date;
}

export class DeviceActiveRepo extends BaseInfluxRepo<DeviceActiveInput> {
  buildPoint(input: DeviceActiveInput): Point {
    const point = new Point('device_active')
      .tag('device_id', input.deviceId)
      .tag('status', input.status)
      .stringField('reason', input.reason);

    if (input.fwVersion) point.stringField('fw_version', input.fwVersion);
    if (input.fwTrack) point.stringField('fw_track', input.fwTrack);
    if (input.ipHash) point.stringField('ip_hash', input.ipHash);
    if (input.userIdAtTime) point.stringField('user_id_at_time', input.userIdAtTime);

    point.timestamp(input.timestamp ?? new Date());
    return point;
  }

  async write(input: DeviceActiveInput): Promise<void> {
    await this.submit(this.buildPoint(input), BucketTarget.METRICS, true);
  }
}
