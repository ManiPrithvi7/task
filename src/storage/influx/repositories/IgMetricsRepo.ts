import { Point } from '@influxdata/influxdb-client';
import { BaseInfluxRepo } from '../BaseInfluxRepo';
import { BucketTarget } from '../types';

export interface IgMetricsInput {
  deviceId: string;
  igId: string;
  trigger: string;
  followersCount: number;
  timestamp?: Date;
}

export class IgMetricsRepo extends BaseInfluxRepo<IgMetricsInput> {
  buildPoint(input: IgMetricsInput): Point {
    return new Point('ig_metrics')
      .tag('device_id', input.deviceId)
      .tag('ig_id', input.igId || 'unknown')
      .tag('trigger', input.trigger)
      .intField('followers_count', Math.round(input.followersCount))
      .timestamp(input.timestamp ?? new Date());
  }

  async write(input: IgMetricsInput): Promise<void> {
    await this.submit(this.buildPoint(input), BucketTarget.METRICS, true);
  }
}
