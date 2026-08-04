import { Point } from '@influxdata/influxdb-client';
import { BaseInfluxRepo } from '../BaseInfluxRepo';
import { BucketTarget } from '../types';
import {
  InstagramFetchAuditInfluxInput,
  ProfileBaselineInfluxInput,
} from '../../../services/influxService';
import { logger } from '../../../utils/logger';

export class InstagramAuditRepo extends BaseInfluxRepo<InstagramFetchAuditInfluxInput> {
  buildPoint(input: InstagramFetchAuditInfluxInput): Point {
    const point = new Point('instagram_fetch_audit')
      .tag('device_id', input.deviceId)
      .tag('success', input.success ? 'true' : 'false')
      .tag('trigger_type', input.triggerType)
      .intField('duration_ms', Math.max(0, Math.round(input.durationMs)));

    // Dual-write tag+field during partner migration (v2.3.x → v2.5.0 tag removal).
    if (input.correlationId) {
      point.tag('correlation_id', input.correlationId);
      point.stringField('correlation_id', input.correlationId);
    }
    if (input.instagramAccountId) {
      point.tag('instagram_account_id', input.instagramAccountId);
      point.stringField('instagram_account_id', input.instagramAccountId);
    }
    if (input.apiEndpoint) {
      point.tag('api_endpoint', input.apiEndpoint);
      point.stringField('api_endpoint', input.apiEndpoint);
    }
    if (!input.success && input.errorCode !== undefined && input.errorCode !== null && String(input.errorCode) !== '') {
      const code = String(input.errorCode);
      point.tag('error_code', code);
      point.stringField('error_code', code);
    }

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
    if (!input.success && input.errorMessage) {
      point.stringField('error_message', this.truncate(input.errorMessage, BucketTarget.METRICS));
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

  buildProfileBaselinePoint(input: ProfileBaselineInfluxInput): Point {
    const point = new Point('profile_baseline')
      .tag('device_id', input.deviceId)
      .tag('platform', input.platform)
      .stringField('connected_at', input.connectedAt.toISOString());

    if (input.platform === 'instagram' && typeof input.followers === 'number') {
      point.intField('followers', Math.round(input.followers));
    }
    if (input.platform === 'gmb') {
      if (typeof input.reviews === 'number') {
        point.intField('reviews', Math.round(input.reviews));
      } else if (typeof input.followers === 'number') {
        point.intField('reviews', Math.round(input.followers));
      }
      if (typeof input.rating === 'number') {
        point.floatField('rating', input.rating);
      }
      if (input.locationId) {
        point.stringField('location_id', input.locationId);
      }
    }

    point.timestamp(input.timestamp ?? new Date());
    return point;
  }

  async writeProfileBaseline(input: ProfileBaselineInfluxInput): Promise<void> {
    await this.submit(this.buildProfileBaselinePoint(input), BucketTarget.METRICS, true);
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
