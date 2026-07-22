import { Point } from '@influxdata/influxdb-client';
import { BaseInfluxRepo } from '../BaseInfluxRepo';
import { BucketTarget } from '../types';
import { normalizeInfluxTimestamp } from '../../../utils/influxTimestamp';
import { logger } from '../../../utils/logger';

export type DeviceOtaEventInput = {
  deviceId: string;
  event: 'boot' | 'ota_fail';
  sourceTopic: 'active' | 'status';
  fwVersion?: string;
  bootType?: string;
  reason?: string;
  ipAddress?: string;
  timestamp?: Date | string;
};

export class DeviceOtaEventsRepo extends BaseInfluxRepo<DeviceOtaEventInput> {
  buildPoint(input: DeviceOtaEventInput): Point {
    const point = new Point('device_ota_events')
      .tag('device_id', input.deviceId)
      .tag('event', input.event)
      .tag('source', 'mqtt-publisher-lite')
      .tag('source_topic', input.sourceTopic);

    if (input.bootType) point.tag('boot_type', input.bootType);
    if (input.reason) point.tag('reason', input.reason);
    if (input.fwVersion) point.stringField('fw_version', input.fwVersion);
    if (input.ipAddress) point.stringField('ip_address', input.ipAddress);

    point.timestamp(normalizeInfluxTimestamp(input.timestamp));
    return point;
  }

  async write(input: DeviceOtaEventInput): Promise<void> {
    try {
      const point = this.buildPoint(input);
      await this.submit(point, BucketTarget.METRICS, false);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('Failed to write device OTA event to InfluxDB', {
        deviceId: input.deviceId,
        event: input.event,
        error: errorMessage
      });
    }
  }
}
