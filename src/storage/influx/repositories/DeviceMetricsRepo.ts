import crypto from 'crypto';
import { Point } from '@influxdata/influxdb-client';
import { BaseInfluxRepo } from '../BaseInfluxRepo';
import { BucketTarget } from '../types';
import { DeviceMetrics, SystemMetrics } from '../../../services/influxService';
import { logger } from '../../../utils/logger';

export class DeviceMetricsRepo extends BaseInfluxRepo<{ deviceId: string; metrics: DeviceMetrics }> {
  buildPoint(input: { deviceId: string; metrics: DeviceMetrics }): Point {
    const { deviceId, metrics } = input;
    const point = new Point('device_metrics')
      .tag('device_id', deviceId)
      .tag('source', 'mqtt-publisher-lite');

    if (typeof metrics.temperature === 'number') point.floatField('temperature', metrics.temperature);
    if (typeof metrics.humidity === 'number') point.floatField('humidity', metrics.humidity);
    if (typeof metrics.pressure === 'number') point.floatField('pressure', metrics.pressure);
    if (typeof metrics.battery === 'number') point.floatField('battery', metrics.battery);
    if (typeof metrics.signal_strength === 'number') point.floatField('signal_strength', metrics.signal_strength);
    if (metrics.location) point.stringField('location', metrics.location);
    if (metrics.status) point.stringField('status', metrics.status);

    point.timestamp(metrics.timestamp ? new Date(metrics.timestamp as string) : new Date());
    return point;
  }

  async write(input: { deviceId: string; metrics: DeviceMetrics }): Promise<void> {
    try {
      const point = this.buildPoint(input);
      await this.submit(point, BucketTarget.METRICS, true);
      logger.debug('Device metrics written to InfluxDB', { deviceId: input.deviceId });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to write device metrics', { deviceId: input.deviceId, error: errorMessage });
      throw error;
    }
  }

  async writeSystemMetrics(metrics: SystemMetrics): Promise<void> {
    try {
      const point = new Point('system_metrics')
        .tag('service', 'mqtt-publisher-lite')
        .tag('host', process.env.HOSTNAME || 'unknown');

      if (typeof metrics.cpu_usage === 'number') point.floatField('cpu_usage', metrics.cpu_usage);
      if (typeof metrics.memory_usage === 'number') point.floatField('memory_usage', metrics.memory_usage);
      if (typeof metrics.connected_clients === 'number') point.intField('connected_clients', metrics.connected_clients);
      if (typeof metrics.mqtt_messages === 'number') point.intField('mqtt_messages', metrics.mqtt_messages);
      if (typeof metrics.uptime === 'number') point.floatField('uptime', metrics.uptime);

      point.timestamp(new Date());
      await this.submit(point, BucketTarget.METRICS, true);
      logger.debug('System metrics written to InfluxDB');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to write system metrics', { error: errorMessage });
      throw error;
    }
  }

  async writeSocialMetrics(platform: string, userId: string, metrics: Record<string, unknown>): Promise<void> {
    try {
      const point = new Point('social_metrics')
        .tag('platform', platform)
        .stringField('user_id_at_time', userId)
        .tag('source', 'mqtt-publisher-lite');

      if (typeof metrics.followers === 'number') point.intField('followers', metrics.followers);
      if (typeof metrics.following === 'number') point.intField('following', metrics.following);
      if (typeof metrics.posts === 'number') point.intField('posts', metrics.posts);
      if (typeof metrics.likes === 'number') point.intField('likes', metrics.likes);
      if (typeof metrics.comments === 'number') point.intField('comments', metrics.comments);
      if (typeof metrics.shares === 'number') point.intField('shares', metrics.shares);
      if (typeof metrics.engagement_rate === 'number') point.floatField('engagement_rate', metrics.engagement_rate);
      if (metrics.post_id) point.stringField('post_id', String(metrics.post_id));
      if (metrics.content_type) point.stringField('content_type', String(metrics.content_type));

      point.timestamp(new Date());
      await this.submit(point, BucketTarget.METRICS, true);
      logger.debug('Social metrics written to InfluxDB', { platform, userId });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to write social metrics', { platform, userId, error: errorMessage });
      throw error;
    }
  }

  async writeRateLimitEvent(data: {
    limitType: string;
    endpoint: string;
    ip: string;
    count: number;
    limit: number;
    deviceId?: string;
  }): Promise<void> {
    try {
      const point = new Point('rate_limit_events')
        .tag('limit_type', data.limitType)
        .tag('endpoint', data.endpoint)
        .tag('ip_hash', crypto.createHash('sha256').update(data.ip).digest('hex'))
        .tag('source', 'mqtt-publisher-lite')
        .intField('count', data.count)
        .intField('limit', data.limit)
        .intField('remaining', Math.max(0, data.limit - data.count))
        .intField('exceeded', 1);

      if (data.deviceId) point.tag('device_id', data.deviceId);
      point.timestamp(new Date());
      await this.submit(point, BucketTarget.METRICS, true);
      logger.debug('Rate limit event written to InfluxDB', { limitType: data.limitType, endpoint: data.endpoint });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('Failed to write rate limit event to InfluxDB', { error: errorMessage });
    }
  }
}
