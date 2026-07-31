import { Point } from '@influxdata/influxdb-client';
import { BaseInfluxRepo } from '../BaseInfluxRepo';
import { BucketTarget } from '../types';

export interface MqttDeliveryInput {
  platform: 'instagram' | 'gmb';
  deviceId: string;
  success: boolean;
  payloadSizeBytes: number;
  correlationId?: string;
  payloadSha256?: string;
  errorMessage?: string;
  timestamp?: Date;
}

export class MqttDeliveryRepo extends BaseInfluxRepo<MqttDeliveryInput> {
  buildPoint(input: MqttDeliveryInput): Point {
    const point = new Point('mqtt_delivery')
      .tag('platform', input.platform)
      .tag('device_id', input.deviceId)
      .booleanField('success', input.success)
      .intField('payload_size_bytes', Math.max(0, Math.round(input.payloadSizeBytes)));

    if (input.correlationId) point.stringField('correlation_id', input.correlationId);
    if (input.payloadSha256) point.stringField('payload_sha256', input.payloadSha256);
    if (!input.success && input.errorMessage) {
      point.stringField('error_message', this.truncate(input.errorMessage, BucketTarget.METRICS));
    }

    point.timestamp(input.timestamp ?? new Date());
    return point;
  }

  async write(input: MqttDeliveryInput): Promise<void> {
    await this.submit(this.buildPoint(input), BucketTarget.METRICS, true);
  }
}
