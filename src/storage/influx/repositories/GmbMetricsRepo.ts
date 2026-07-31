import { Point } from '@influxdata/influxdb-client';
import { BaseInfluxRepo } from '../BaseInfluxRepo';
import { BucketTarget } from '../types';

export interface GmbMetricsInput {
  deviceId: string;
  locationId: string;
  trigger: string;
  reviewsCount: number;
  averageRating: number;
  timestamp?: Date;
}

export class GmbMetricsRepo extends BaseInfluxRepo<GmbMetricsInput> {
  buildPoint(input: GmbMetricsInput): Point {
    return new Point('gmb_metrics')
      .tag('device_id', input.deviceId)
      .tag('location_id', input.locationId)
      .tag('trigger', input.trigger)
      .intField('reviews_count', Math.max(0, Math.round(input.reviewsCount)))
      .floatField('average_rating', input.averageRating)
      .timestamp(input.timestamp ?? new Date());
  }

  async write(input: GmbMetricsInput): Promise<void> {
    await this.submit(this.buildPoint(input), BucketTarget.METRICS, true);
  }
}
