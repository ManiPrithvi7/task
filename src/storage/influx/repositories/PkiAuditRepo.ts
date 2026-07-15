import { Point } from '@influxdata/influxdb-client';
import { BaseInfluxRepo } from '../BaseInfluxRepo';
import { BucketTarget } from '../types';
import { logger } from '../../../utils/logger';

export interface PkiAuditInput {
  event: string;
  deviceId?: string;
  userId?: string;
  orderId?: string;
  batchId?: string;
  serialNumber?: string;
  certificateFingerprint?: string;
  sequence?: number;
  hash?: string;
  previousHash?: string;
  details?: Record<string, unknown>;
}

export class PkiAuditRepo extends BaseInfluxRepo<PkiAuditInput> {
  buildPoint(input: PkiAuditInput): Point {
    const point = new Point('pki_audit')
      .tag('event', input.event)
      .tag('source', 'mqtt-publisher-lite');

    if (input.deviceId) point.tag('device_id', input.deviceId);
    if (input.orderId) point.tag('order_id', input.orderId);
    if (input.batchId) point.tag('batch_id', input.batchId);
    if (input.userId) point.stringField('user_id_at_time', input.userId);
    if (input.serialNumber) point.stringField('serial_number', input.serialNumber);
    if (input.certificateFingerprint) point.stringField('cert_fingerprint', input.certificateFingerprint);
    if (typeof input.sequence === 'number') point.intField('sequence', input.sequence);
    if (input.hash) point.stringField('hash', input.hash);
    if (input.previousHash) point.stringField('previous_hash', input.previousHash);
    if (input.details) point.stringField('details', this.truncate(JSON.stringify(input.details)));

    point.intField('count', 1);
    point.timestamp(new Date());
    return point;
  }

  async write(input: PkiAuditInput): Promise<void> {
    try {
      const point = this.buildPoint(input);
      await this.submit(point, BucketTarget.COMPLIANCE, true);
      logger.debug('PKI audit event written to InfluxDB', { event: input.event, deviceId: input.deviceId });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to write PKI audit to InfluxDB', { event: input.event, error: errorMessage });
      throw error;
    }
  }
}
