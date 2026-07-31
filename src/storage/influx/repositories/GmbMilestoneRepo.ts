import { Point } from '@influxdata/influxdb-client';
import { BaseInfluxRepo } from '../BaseInfluxRepo';
import { BucketTarget } from '../types';

export interface GmbMilestoneInput {
  deviceId: string;
  locationId: string;
  reviewsCount: number;
  velocity: number;
  createdAt: string;
  timestamp?: Date;
}

export class GmbMilestoneRepo extends BaseInfluxRepo<GmbMilestoneInput> {
  buildPoint(input: GmbMilestoneInput): Point {
    return new Point('gmb_milestone')
      .tag('device_id', input.deviceId)
      .tag('location_id', input.locationId)
      .intField('reviews_count', Math.max(0, Math.round(input.reviewsCount)))
      .floatField('velocity', input.velocity)
      .stringField('created_at', input.createdAt)
      .timestamp(input.timestamp ?? new Date());
  }

  async write(input: GmbMilestoneInput): Promise<void> {
    await this.submit(this.buildPoint(input), BucketTarget.METRICS, true);
  }
}
