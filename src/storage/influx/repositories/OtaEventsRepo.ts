import { Point } from '@influxdata/influxdb-client';
import { BaseInfluxRepo } from '../BaseInfluxRepo';
import { BucketTarget } from '../types';
import { normalizeInfluxTimestamp } from '../../../utils/influxTimestamp';
import { logger } from '../../../utils/logger';

/** Reduced device_ota_events schema (merged DeviceOtaEventsRepo + OtaTelemetryRepo). */
export interface OtaEventsInput {
  deviceId: string;
  event: string;
  source: string;
  fwVersion?: string;
  ipAddress?: string;
  errorMessage?: string;
  errorCode?: string;
  otaBytes?: number;
  certDaysRemaining?: number;
  certRenewalNeeded?: boolean;
  sha256Match?: boolean;
  signatureValid?: boolean;
  attemptNumber?: number;
  fromVersion?: string;
  payloadHash?: string;
  timestamp?: Date | string;
}

export class OtaEventsRepo extends BaseInfluxRepo<OtaEventsInput> {
  buildPoint(input: OtaEventsInput): Point {
    const point = new Point('device_ota_events')
      .tag('device_id', input.deviceId)
      .tag('event', input.event)
      .tag('source', input.source);

    if (input.fwVersion) point.stringField('fw_version', input.fwVersion);
    if (input.ipAddress) point.stringField('ip_address', input.ipAddress);
    if (input.errorMessage) {
      point.stringField('error_message', this.truncate(input.errorMessage, BucketTarget.METRICS));
    }
    if (input.errorCode) point.stringField('error_code', input.errorCode);
    if (typeof input.otaBytes === 'number') point.intField('ota_bytes', Math.round(input.otaBytes));
    if (typeof input.certDaysRemaining === 'number') {
      point.intField('cert_days_remaining', Math.round(input.certDaysRemaining));
    }
    if (typeof input.certRenewalNeeded === 'boolean') {
      point.booleanField('cert_renewal_needed', input.certRenewalNeeded);
    }
    if (typeof input.sha256Match === 'boolean') point.booleanField('sha256_match', input.sha256Match);
    if (typeof input.signatureValid === 'boolean') {
      point.booleanField('signature_valid', input.signatureValid);
    }
    if (typeof input.attemptNumber === 'number') {
      point.intField('attempt_number', Math.round(input.attemptNumber));
    }
    if (input.fromVersion) point.stringField('from_version', input.fromVersion);
    if (input.payloadHash) point.stringField('payload_hash', input.payloadHash);

    point.timestamp(normalizeInfluxTimestamp(input.timestamp));
    return point;
  }

  async write(input: OtaEventsInput): Promise<void> {
    try {
      await this.submit(this.buildPoint(input), BucketTarget.METRICS, true);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('Failed to write device_ota_events', {
        deviceId: input.deviceId,
        event: input.event,
        error: errorMessage
      });
    }
  }
}
