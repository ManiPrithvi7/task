import { Point } from '@influxdata/influxdb-client';
import { BaseInfluxRepo } from '../BaseInfluxRepo';
import { BucketTarget } from '../types';
import {
  InstagramFetchAuditInfluxInput,
  InstagramMilestoneCrossedInfluxInput,
  InstagramMqttDeliveryInfluxInput,
  InstagramCircuitEventInfluxInput,
  MilestoneCrossedInfluxInput,
  ProfileBaselineInfluxInput,
  VelocityWeeklyInfluxInput,
} from '../../../services/influxService';
import { logger } from '../../../utils/logger';

export class InstagramAuditRepo extends BaseInfluxRepo<InstagramFetchAuditInfluxInput> {
  buildPoint(input: InstagramFetchAuditInfluxInput): Point {
    const point = new Point('instagram_fetch_audit')
      .tag('device_id', input.deviceId)
      .stringField('user_id_at_time', input.userId || 'unknown')
      .tag('success', input.success ? 'true' : 'false')
      .tag('trigger_type', input.triggerType);

    if (input.correlationId) point.tag('correlation_id', input.correlationId);
    if (input.instagramAccountId) point.tag('instagram_account_id', input.instagramAccountId);
    if (input.apiEndpoint) point.tag('api_endpoint', input.apiEndpoint);
    if (!input.success && input.errorCode !== undefined && input.errorCode !== null && String(input.errorCode) !== '') {
      point.tag('error_code', String(input.errorCode));
    }

    point.intField('duration_ms', Math.max(0, Math.round(input.durationMs)));

    if (input.oldFollowers !== null && input.oldFollowers !== undefined && !Number.isNaN(input.oldFollowers)) {
      point.intField('old_followers', Math.round(input.oldFollowers));
    }
    if (input.newFollowers !== null && input.newFollowers !== undefined && !Number.isNaN(input.newFollowers)) {
      point.intField('new_followers', Math.round(input.newFollowers));
    }
    if (typeof input.httpStatus === 'number' && Number.isFinite(input.httpStatus)) {
      point.intField('http_status', Math.round(input.httpStatus));
    }
    if (typeof input.retryAfterSeconds === 'number' && Number.isFinite(input.retryAfterSeconds)) {
      point.intField('retry_after_seconds', Math.round(input.retryAfterSeconds));
    }
    if (typeof input.cacheHit === 'boolean') {
      point.booleanField('cache_hit', input.cacheHit);
    }
    if (typeof input.mediaCount === 'number' && Number.isFinite(input.mediaCount)) {
      point.intField('media_count', Math.round(input.mediaCount));
    }
    if (!input.success && input.errorMessage) {
      point.stringField('error_message', this.truncate(input.errorMessage));
    }
    if (input.primaryResponseSha256) {
      point.stringField('primary_response_sha256', input.primaryResponseSha256);
    }
    if (input.detailsResponseSha256) {
      point.stringField('details_response_sha256', input.detailsResponseSha256);
    }

    point.timestamp(input.timestamp ?? new Date());
    return point;
  }

  async write(input: InstagramFetchAuditInfluxInput): Promise<void> {
    try {
      const point = this.buildPoint(input);
      await this.submit(point, BucketTarget.METRICS, true);
      logger.debug('Instagram fetch audit written to InfluxDB', { deviceId: input.deviceId, success: input.success });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to write instagram_fetch_audit', { deviceId: input.deviceId, error: errorMessage });
      throw error;
    }
  }

  async writeFollowersGauge(
    deviceId: string,
    instagramAccountId: string,
    followers: number,
    timestamp?: Date,
    mediaCount?: number,
  ): Promise<void> {
    const point = new Point('instagram_metrics')
      .tag('device_id', deviceId)
      .tag('instagram_account_id', instagramAccountId || 'unknown')
      .intField('followers', Math.round(followers));
    if (typeof mediaCount === 'number' && Number.isFinite(mediaCount)) {
      point.intField('media_count', Math.round(mediaCount));
    }
    point.timestamp(timestamp ?? new Date());
    await this.submit(point, BucketTarget.METRICS, true);
  }

  async writeMilestoneCrossed(input: MilestoneCrossedInfluxInput): Promise<void> {
    const point = new Point('milestone_crossed')
      .tag('platform', input.platform)
      .tag('device_id', input.deviceId)
      .stringField('user_id_at_time', input.userId || 'unknown')
      .tag('trigger', input.trigger)
      .intField('milestone', Math.round(input.milestone))
      .intField('old_value', Math.round(input.oldValue))
      .intField('new_value', Math.round(input.newValue));
    if (input.platform === 'instagram' && input.instagramAccountId) {
      point.tag('instagram_account_id', input.instagramAccountId);
    }
    if (input.platform === 'gmb' && input.locationId) {
      point.tag('location_id', input.locationId);
    }
    point.timestamp(input.timestamp ?? new Date());
    await this.submit(point, BucketTarget.METRICS, true);
  }

  async writeInstagramMilestoneCrossed(input: InstagramMilestoneCrossedInfluxInput): Promise<void> {
    await this.writeMilestoneCrossed({
      platform: 'instagram',
      deviceId: input.deviceId,
      userId: input.userId,
      trigger: input.trigger,
      milestone: input.milestone,
      oldValue: input.oldFollowers,
      newValue: input.newFollowers,
      instagramAccountId: input.instagramAccountId,
      timestamp: input.timestamp,
    });
  }

  async writeMqttDelivery(input: InstagramMqttDeliveryInfluxInput): Promise<void> {
    const point = new Point('instagram_mqtt_delivery')
      .tag('device_id', input.deviceId)
      .stringField('user_id_at_time', input.userId || 'unknown');
    if (input.instagramAccountId) point.tag('instagram_account_id', input.instagramAccountId);
    if (input.correlationId) point.tag('correlation_id', input.correlationId);
    point
      .booleanField('success', input.success)
      .booleanField('was_heartbeat', input.wasHeartbeat)
      .intField('payload_size_bytes', Math.max(0, Math.round(input.payloadSizeBytes)));
    if (!input.success && input.errorMessage) {
      point.stringField('error_message', this.truncate(input.errorMessage));
    }
    point.timestamp(input.timestamp ?? new Date());
    await this.submit(point, BucketTarget.METRICS, true);
  }

  async writeCircuitEvent(input: InstagramCircuitEventInfluxInput): Promise<void> {
    const point = new Point('instagram_circuit_event')
      .tag('state', input.state)
      .tag('reason', input.reason);
    if (input.state === 'open' && typeof input.retryAfterSeconds === 'number' && Number.isFinite(input.retryAfterSeconds)) {
      point.intField('retry_after_seconds', Math.max(1, Math.round(input.retryAfterSeconds)));
    }
    point.timestamp(input.timestamp ?? new Date());
    await this.submit(point, BucketTarget.METRICS, true);
  }

  async writeProfileBaseline(input: ProfileBaselineInfluxInput): Promise<void> {
    const point = new Point('profile_baseline')
      .tag('device_id', input.deviceId)
      .tag('platform', input.platform)
      .stringField('user_id_at_time', input.userId || 'unknown')
      .intField('followers', Math.round(input.followers))
      .stringField('connected_at', input.connectedAt.toISOString());
    if (input.platform === 'gmb' && typeof input.rating === 'number') {
      point.floatField('rating', input.rating);
    }
    point.timestamp(input.timestamp ?? new Date());
    await this.submit(point, BucketTarget.METRICS, true);
  }

  async writeVelocityWeekly(input: VelocityWeeklyInfluxInput): Promise<void> {
    const point = new Point('velocity_weekly')
      .tag('device_id', input.deviceId)
      .tag('platform', input.platform)
      .tag('week_of_year', input.weekOfYear)
      .intField('count', Math.round(input.count))
      .floatField('velocity_per_day', input.velocityPerDay)
      .timestamp(input.timestamp ?? new Date());
    await this.submit(point, BucketTarget.METRICS, true);
  }

  async writeAttentionE2eLatency(
    deviceId: string,
    triggerType: string,
    latencyMs: number,
    timestamp?: Date,
  ): Promise<void> {
    const point = new Point('instagram_attention_e2e')
      .tag('device_id', deviceId)
      .tag('trigger', triggerType)
      .intField('latency_ms', Math.round(latencyMs))
      .timestamp(timestamp ?? new Date());
    await this.submit(point, BucketTarget.METRICS, true);
  }
}
