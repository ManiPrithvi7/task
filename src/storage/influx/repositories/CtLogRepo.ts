import { Point } from '@influxdata/influxdb-client';
import { BaseInfluxRepo } from '../BaseInfluxRepo';
import { BucketTarget } from '../types';
import { logger } from '../../../utils/logger';

export interface TransparencyEntryInput {
  index: number;
  leafHash: string;
  rootHash: string;
  inclusionProof: string;
  certFingerprint: string;
  serialNumber: string;
  cn: string;
  deviceId: string;
  issuedAt: Date;
}

export interface OtaReleaseEntryInput {
  index: number;
  leafHash: string;
  rootHash: string;
  inclusionProof: string;
  version: string;
  sha256: string;
  objectKey: string;
  keyFingerprint: string;
  releasedAt: Date;
}

export class CtLogRepo extends BaseInfluxRepo<TransparencyEntryInput> {
  buildPoint(input: TransparencyEntryInput): Point {
    return new Point('ct_log')
      .tag('device_id', input.deviceId)
      .tag('cn', input.cn)
      .tag('source', 'mqtt-publisher-lite')
      .intField('index', input.index)
      .stringField('leaf_hash', input.leafHash)
      .stringField('root_hash', input.rootHash)
      .stringField('inclusion_proof', input.inclusionProof)
      .stringField('cert_fingerprint', input.certFingerprint)
      .stringField('serial_number', input.serialNumber)
      .timestamp(input.issuedAt);
  }

  async write(input: TransparencyEntryInput): Promise<void> {
    try {
      const point = this.buildPoint(input);
      await this.submit(point, BucketTarget.COMPLIANCE, true);
      logger.debug('CT log entry written to InfluxDB', { index: input.index, deviceId: input.deviceId });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to write CT log entry to InfluxDB', { index: input.index, error: errorMessage });
      throw error;
    }
  }

  async writeOtaReleaseEntry(input: OtaReleaseEntryInput): Promise<void> {
    try {
      const point = new Point('ota_release_log')
        .tag('version', input.version)
        .tag('source', 'mqtt-publisher-lite')
        .intField('index', input.index)
        .stringField('leaf_hash', input.leafHash)
        .stringField('root_hash', input.rootHash)
        .stringField('inclusion_proof', input.inclusionProof)
        .stringField('sha256', input.sha256)
        .stringField('object_key', input.objectKey)
        .stringField('key_fingerprint', input.keyFingerprint)
        .timestamp(input.releasedAt);

      await this.submit(point, BucketTarget.COMPLIANCE, true);
      logger.debug('OTA release log entry written to InfluxDB', { index: input.index, version: input.version });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to write OTA release log entry', { index: input.index, error: errorMessage });
      throw error;
    }
  }
}
