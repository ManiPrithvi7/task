import { Point } from '@influxdata/influxdb-client';
import { BaseInfluxRepo } from '../BaseInfluxRepo';
import { BucketTarget } from '../types';
import { GmbWebhookAuditInfluxInput } from '../../../services/influxService';

export class WebhookAuditRepo extends BaseInfluxRepo<GmbWebhookAuditInfluxInput> {
  buildPoint(input: GmbWebhookAuditInfluxInput): Point {
    const point = new Point('gmb_webhook_audit')
      .tag('location_id', input.locationId || 'unknown')
      .tag('event_type', input.eventType || 'unknown');

    if (input.deviceId) point.tag('device_id', input.deviceId);

    point
      .stringField('received_at', input.receivedAt)
      .booleanField('verified', input.verified)
      .booleanField('signature_valid', input.signatureValid)
      .intField('payload_size_bytes', input.payloadSizeBytes)
      .stringField('payload_sha256', input.payloadSha256);

    if (input.webhookId) point.stringField('webhook_id', input.webhookId);
    if (input.processedAt) point.stringField('processed_at', input.processedAt);
    if (typeof input.processingMs === 'number') {
      point.intField('processing_ms', Math.round(input.processingMs));
    }
    if (typeof input.resolvedDeviceCount === 'number') {
      point.intField('resolved_device_count', Math.max(0, Math.round(input.resolvedDeviceCount)));
    }
    if (input.correlationId) point.stringField('correlation_id', input.correlationId);
    if (input.errorMessage) {
      point.stringField('error_message', this.truncate(input.errorMessage, BucketTarget.METRICS));
    }

    point.timestamp(input.timestamp ?? new Date());
    return point;
  }

  async write(input: GmbWebhookAuditInfluxInput): Promise<void> {
    await this.submit(this.buildPoint(input), BucketTarget.METRICS, true);
  }

  async writeGmbWebhookAudit(input: GmbWebhookAuditInfluxInput): Promise<void> {
    await this.write(input);
  }
}
