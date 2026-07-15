import { Point } from '@influxdata/influxdb-client';
import { BaseInfluxRepo } from '../BaseInfluxRepo';
import { BucketTarget } from '../types';
import {
  WebhookReceivedInfluxInput,
  WebhookDeviceResolutionInfluxInput,
  WebhookMqttDeliveryInfluxInput,
  GmbReviewSnapshotInfluxInput,
  GmbWebhookAuditInfluxInput,
  GmbVelocityWeeklyInfluxInput,
} from '../../../services/influxService';

export class WebhookAuditRepo extends BaseInfluxRepo<WebhookReceivedInfluxInput> {
  buildPoint(input: WebhookReceivedInfluxInput): Point {
    const point = new Point('webhook_received')
      .tag('platform', input.platform)
      .tag('event_type', input.eventType || 'unknown')
      .tag('verified', input.verified ? 'true' : 'false');
    if (input.locationId) point.tag('location_id', input.locationId);
    point.timestamp(input.timestamp ?? new Date());
    return point;
  }

  async write(input: WebhookReceivedInfluxInput): Promise<void> {
    const point = this.buildPoint(input);
    await this.submit(point, BucketTarget.METRICS, true);
  }

  async writeDeviceResolution(input: WebhookDeviceResolutionInfluxInput): Promise<void> {
    const point = new Point('webhook_device_resolution')
      .tag('platform', input.platform)
      .tag('external_id', input.externalId)
      .stringField('user_id_at_time', input.userId?.trim() || 'unknown')
      .intField('resolved_device_count', Math.max(0, Math.round(input.resolvedDeviceCount)));
    if (input.errorMessage) {
      point.stringField('error_message', this.truncate(input.errorMessage));
    }
    point.timestamp(input.timestamp ?? new Date());
    await this.submit(point, BucketTarget.METRICS, true);
  }

  async writeMqttDelivery(input: WebhookMqttDeliveryInfluxInput): Promise<void> {
    const point = new Point('webhook_mqtt_delivery')
      .tag('platform', input.platform)
      .tag('device_id', input.deviceId)
      .stringField('user_id_at_time', input.userId?.trim() || 'unknown')
      .booleanField('success', input.success)
      .booleanField('published', input.published)
      .intField('payload_size_bytes', Math.max(0, Math.round(input.payloadSizeBytes)))
      .stringField('payload_sha256', input.payloadSha256);
    if (!input.success && input.errorMessage) {
      point.stringField('error_message', this.truncate(input.errorMessage));
    }
    point.timestamp(input.timestamp ?? new Date());
    await this.submit(point, BucketTarget.METRICS, true);
  }

  async writeGmbReviewSnapshot(input: GmbReviewSnapshotInfluxInput): Promise<void> {
    const point = new Point('gmb_review_snapshot')
      .tag('device_id', input.deviceId)
      .tag('location_id', input.locationId)
      .stringField('user_id_at_time', input.userId || 'unknown')
      .intField('total_reviews', Math.max(0, Math.round(input.totalReviews)))
      .floatField('average_rating', input.averageRating)
      .intField('new_reviews_24h', Math.max(0, Math.round(input.newReviews24h)))
      .intField('new_reviews_7d', Math.max(0, Math.round(input.newReviews7d)))
      .timestamp(input.timestamp ?? new Date());
    await this.submit(point, BucketTarget.METRICS, true);
  }

  async writeGmbWebhookAudit(input: GmbWebhookAuditInfluxInput): Promise<void> {
    const point = new Point('gmb_webhook_audit')
      .tag('location_id', input.locationId)
      .tag('event_type', input.eventType);
    if (input.deviceId) point.tag('device_id', input.deviceId);
    if (input.webhookId) point.tag('webhook_id', input.webhookId);
    if (input.userId) point.stringField('user_id_at_time', input.userId);
    point
      .stringField('received_at', input.receivedAt)
      .booleanField('verified', input.verified)
      .booleanField('signature_valid', input.signatureValid)
      .intField('payload_size_bytes', input.payloadSizeBytes)
      .stringField('payload_sha256', input.payloadSha256);
    if (input.processedAt) point.stringField('processed_at', input.processedAt);
    if (typeof input.processingMs === 'number') point.intField('processing_ms', Math.round(input.processingMs));
    if (input.errorMessage) point.stringField('error_message', this.truncate(input.errorMessage));
    point.timestamp(input.timestamp ?? new Date());
    await this.submit(point, BucketTarget.METRICS, true);
  }

  async writeGmbVelocityWeekly(input: GmbVelocityWeeklyInfluxInput): Promise<void> {
    const point = new Point('gmb_velocity_weekly')
      .tag('device_id', input.deviceId)
      .tag('location_id', input.locationId)
      .tag('week_of_year', input.weekOfYear)
      .stringField('user_id_at_time', input.userId || 'unknown')
      .intField('review_count_start', Math.round(input.reviewCountStart))
      .intField('review_count_end', Math.round(input.reviewCountEnd))
      .intField('new_reviews', Math.round(input.newReviews))
      .floatField('velocity_per_day', input.velocityPerDay)
      .floatField('rating_start', input.ratingStart)
      .floatField('rating_end', input.ratingEnd)
      .floatField('rating_delta', input.ratingDelta)
      .timestamp(input.timestamp ?? new Date());
    await this.submit(point, BucketTarget.METRICS, true);
  }
}
