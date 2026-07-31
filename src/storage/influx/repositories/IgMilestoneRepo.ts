import { Point } from '@influxdata/influxdb-client';
import { BaseInfluxRepo } from '../BaseInfluxRepo';
import { BucketTarget } from '../types';

export interface IgMilestoneInput {
  deviceId: string;
  igId: string;
  followersCount: number;
  velocity: number;
  createdAt: string;
  timestamp?: Date;
}

export class IgMilestoneRepo extends BaseInfluxRepo<IgMilestoneInput> {
  buildPoint(input: IgMilestoneInput): Point {
    return new Point('ig_milestone')
      .tag('device_id', input.deviceId)
      .tag('ig_id', input.igId || 'unknown')
      .intField('followers_count', Math.round(input.followersCount))
      .floatField('velocity', input.velocity)
      .stringField('created_at', input.createdAt)
      .timestamp(input.timestamp ?? new Date());
  }

  async write(input: IgMilestoneInput): Promise<void> {
    await this.submit(this.buildPoint(input), BucketTarget.METRICS, true);
  }
}
