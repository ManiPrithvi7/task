import { Point } from '@influxdata/influxdb-client';
import { BaseInfluxRepo } from '../BaseInfluxRepo';
import { BucketTarget } from '../types';
import { logger } from '../../../utils/logger';

export interface OtaTelemetryInput {
  deviceId: string;
  event: string;
  timestamp?: string;

  current_version?: string;
  target_version?: string;
  from_version?: string;
  to_version?: string;
  offered_version?: string;
  attempted_version?: string;
  reverted_to?: string;
  fw_version?: string;

  ota_progress_pct?: number;
  ota_bytes?: number;
  ota_bytes_total?: number;

  elapsed_ms?: number;
  estimated_remaining_ms?: number;
  download_duration_ms?: number;
  validation_duration_ms?: number;

  reason?: string;
  error_code?: string;
  error_message?: string;
  http_code?: number;
  expected_sha256?: string;
  computed_sha256?: string;

  uptime_s?: number;
  free_heap?: number;
  battery?: number;
  signal_strength?: number;
  cert_days_remaining?: number;
  cert_renewal_needed?: boolean;
  wifi_rssi?: number;

  partition?: string;
  boot_reason?: string;
  ota_state?: string;

  checks_passed?: number;
  checks_total?: number;
  attempt_number?: number;
  attempt_count?: number;

  firmware_size?: number;
  cooldown_remaining_s?: number;
  sha256_match?: boolean;
  signature_valid?: boolean;
  time_sync_ok?: boolean;

  source_topic?: string;
}

export class OtaTelemetryRepo extends BaseInfluxRepo<OtaTelemetryInput> {
  buildPoint(input: OtaTelemetryInput): Point {
    const point = new Point('device_ota_events')
      .tag('device_id', input.deviceId)
      .tag('event', input.event)
      .tag('source', 'mqtt-publisher-lite');

    if (input.target_version) point.tag('target_version', input.target_version);
    if (input.from_version) point.tag('from_version', input.from_version);
    if (input.to_version) point.tag('to_version', input.to_version);
    if (input.reason) point.tag('reason', input.reason);
    if (input.error_code) point.tag('error_code', input.error_code);
    if (input.partition) point.tag('partition', input.partition);
    if (input.boot_reason) point.tag('boot_reason', input.boot_reason);
    if (input.ota_state) point.tag('ota_state', input.ota_state);
    if (input.source_topic) point.tag('source_topic', input.source_topic);
    if (input.current_version) point.tag('current_version', input.current_version);

    if (typeof input.ota_progress_pct === 'number') point.floatField('ota_progress_pct', input.ota_progress_pct);
    if (typeof input.ota_bytes === 'number') point.intField('ota_bytes', input.ota_bytes);
    if (typeof input.ota_bytes_total === 'number') point.intField('ota_bytes_total', input.ota_bytes_total);
    if (typeof input.elapsed_ms === 'number') point.intField('elapsed_ms', input.elapsed_ms);
    if (typeof input.estimated_remaining_ms === 'number') point.intField('estimated_remaining_ms', input.estimated_remaining_ms);
    if (typeof input.download_duration_ms === 'number') point.intField('download_duration_ms', input.download_duration_ms);
    if (typeof input.validation_duration_ms === 'number') point.intField('validation_duration_ms', input.validation_duration_ms);
    if (typeof input.uptime_s === 'number') point.intField('uptime_s', input.uptime_s);
    if (typeof input.free_heap === 'number') point.intField('free_heap', input.free_heap);
    if (typeof input.battery === 'number') point.floatField('battery', input.battery);
    if (typeof input.signal_strength === 'number') point.floatField('signal_strength', input.signal_strength);
    if (typeof input.cert_days_remaining === 'number') point.intField('cert_days_remaining', input.cert_days_remaining);
    if (typeof input.cert_renewal_needed === 'boolean') point.booleanField('cert_renewal_needed', input.cert_renewal_needed);
    if (typeof input.wifi_rssi === 'number') point.floatField('wifi_rssi', input.wifi_rssi);
    if (typeof input.checks_passed === 'number') point.intField('checks_passed', input.checks_passed);
    if (typeof input.checks_total === 'number') point.intField('checks_total', input.checks_total);
    if (typeof input.attempt_number === 'number') point.intField('attempt_number', input.attempt_number);
    if (typeof input.attempt_count === 'number') point.intField('attempt_count', input.attempt_count);
    if (typeof input.firmware_size === 'number') point.intField('firmware_size', input.firmware_size);
    if (typeof input.cooldown_remaining_s === 'number') point.intField('cooldown_remaining_s', input.cooldown_remaining_s);
    if (typeof input.sha256_match === 'boolean') point.booleanField('sha256_match', input.sha256_match);
    if (typeof input.signature_valid === 'boolean') point.booleanField('signature_valid', input.signature_valid);
    if (typeof input.time_sync_ok === 'boolean') point.booleanField('time_sync_ok', input.time_sync_ok);
    if (input.http_code !== undefined) point.intField('http_code', input.http_code);
    if (input.error_message) point.stringField('error_message', this.truncate(input.error_message));

    point.timestamp(input.timestamp ? new Date(input.timestamp) : new Date());
    return point;
  }

  async write(input: OtaTelemetryInput): Promise<void> {
    try {
      const point = this.buildPoint(input);
      await this.submit(point, BucketTarget.METRICS, true);
      logger.debug('OTA telemetry written to InfluxDB', {
        deviceId: input.deviceId,
        event: input.event,
        progress: input.ota_progress_pct
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to write OTA telemetry', { deviceId: input.deviceId, event: input.event, error: errorMessage });
    }
  }
}
