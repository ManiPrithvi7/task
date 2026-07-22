/**
 * InfluxDB Service for mqtt-publisher-lite
 * Time-series metrics storage for device, social media, and system metrics.
 *
 * Dual-bucket architecture:
 *   metrics      — operational time-series (device_metrics, social_metrics, instagram_fetch_audit, etc.)
 *   pki_compliance — PKI hash chain + CT log (pki_audit, ct_log)
 *
 * Local: docker compose InfluxDB 2.x (e.g. 8086).
 * Hosted: set INFLUXDB_URL to the public HTTPS origin only — no port when TLS terminates at the proxy (e.g. Render → container :10000).
 * Config via env: INFLUXDB_URL, INFLUXDB_TOKEN, INFLUXDB_ORG, INFLUXDB_BUCKET, INFLUXDB_COMPLIANCE_BUCKET
 */

import { InfluxDB, WriteApi, QueryApi } from '@influxdata/influxdb-client';
import { logger } from '../utils/logger';
import { InfluxDBConfig } from '../config';
import { InfluxDiskQueue } from './influxDiskQueue';

import { BucketTarget } from '../storage/influx/types';
import { DeviceMetricsRepo } from '../storage/influx/repositories/DeviceMetricsRepo';
import { DeviceOtaEventsRepo, DeviceOtaEventInput } from '../storage/influx/repositories/DeviceOtaEventsRepo';
import { InstagramAuditRepo } from '../storage/influx/repositories/InstagramAuditRepo';
import { WebhookAuditRepo } from '../storage/influx/repositories/WebhookAuditRepo';
import { PkiAuditRepo } from '../storage/influx/repositories/PkiAuditRepo';
import { CtLogRepo } from '../storage/influx/repositories/CtLogRepo';
import { OtaTelemetryRepo, type OtaTelemetryInput } from '../storage/influx/repositories/OtaTelemetryRepo';

export interface DeviceMetrics {
  temperature?: number;
  humidity?: number;
  pressure?: number;
  battery?: number;
  signal_strength?: number;
  location?: string;
  status?: string;
  timestamp?: string | Date;
  [key: string]: unknown;
}

export interface SocialMetrics {
  followers?: number;
  following?: number;
  posts?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  engagement_rate?: number;
  post_id?: string;
  content_type?: string;
  [key: string]: unknown;
}

export interface SystemMetrics {
  cpu_usage?: number;
  memory_usage?: number;
  connected_clients?: number;
  mqtt_messages?: number;
  uptime?: number;
  [key: string]: unknown;
}

export interface InstagramFetchAuditInfluxInput {
  deviceId: string;
  userId: string;
  success: boolean;
  triggerType: string;
  correlationId?: string;
  instagramAccountId?: string;
  oldFollowers: number | null;
  newFollowers: number | null;
  durationMs: number;
  errorMessage?: string;
  errorCode?: string | number;
  httpStatus?: number;
  retryAfterSeconds?: number;
  cacheHit?: boolean;
  mediaCount?: number;
  apiEndpoint?: string;
  primaryResponseSha256?: string;
  detailsResponseSha256?: string;
  timestamp?: Date;
}

export interface InstagramMilestoneCrossedInfluxInput {
  deviceId: string;
  userId: string;
  instagramAccountId: string;
  trigger: string;
  milestone: number;
  oldFollowers: number;
  newFollowers: number;
  timestamp?: Date;
}

export interface InstagramMqttDeliveryInfluxInput {
  deviceId: string;
  userId: string;
  instagramAccountId?: string;
  correlationId?: string;
  success: boolean;
  wasHeartbeat: boolean;
  payloadSizeBytes: number;
  errorMessage?: string;
  timestamp?: Date;
}

export interface InstagramCircuitEventInfluxInput {
  state: 'open' | 'closed';
  reason: string;
  retryAfterSeconds?: number;
  timestamp?: Date;
}

export type WebhookPlatform = 'gmb';

export interface WebhookReceivedInfluxInput {
  platform: WebhookPlatform;
  eventType: string;
  verified: boolean;
  locationId?: string;
  timestamp?: Date;
}

export interface WebhookDeviceResolutionInfluxInput {
  platform: WebhookPlatform;
  externalId: string;
  userId?: string;
  resolvedDeviceCount: number;
  errorMessage?: string;
  timestamp?: Date;
}

export interface WebhookMqttDeliveryInfluxInput {
  platform: WebhookPlatform;
  deviceId: string;
  userId?: string;
  success: boolean;
  published: boolean;
  payloadSizeBytes: number;
  payloadSha256: string;
  errorMessage?: string;
  timestamp?: Date;
}

export interface MilestoneCrossedInfluxInput {
  platform: 'instagram' | 'gmb';
  deviceId: string;
  userId: string;
  trigger: string;
  milestone: number;
  oldValue: number;
  newValue: number;
  instagramAccountId?: string;
  locationId?: string;
  timestamp?: Date;
}

export interface ProfileBaselineInfluxInput {
  deviceId: string;
  platform: 'instagram' | 'gmb';
  userId: string;
  followers: number;
  rating?: number;
  connectedAt: Date;
  timestamp?: Date;
}

export interface VelocityWeeklyInfluxInput {
  deviceId: string;
  platform: 'instagram' | 'gmb' | 'combined';
  weekOfYear: string;
  count: number;
  velocityPerDay: number;
  timestamp?: Date;
}

export interface GmbReviewSnapshotInfluxInput {
  deviceId: string;
  locationId: string;
  userId: string;
  totalReviews: number;
  averageRating: number;
  newReviews24h: number;
  newReviews7d: number;
  timestamp?: Date;
}

export interface GmbWebhookAuditInfluxInput {
  deviceId?: string;
  locationId: string;
  eventType: string;
  webhookId?: string;
  userId?: string;
  receivedAt: string;
  processedAt?: string;
  processingMs?: number;
  verified: boolean;
  signatureValid: boolean;
  payloadSizeBytes: number;
  payloadSha256: string;
  errorMessage?: string;
  timestamp?: Date;
}

export interface GmbVelocityWeeklyInfluxInput {
  deviceId: string;
  locationId: string;
  weekOfYear: string;
  userId: string;
  reviewCountStart: number;
  reviewCountEnd: number;
  newReviews: number;
  velocityPerDay: number;
  ratingStart: number;
  ratingEnd: number;
  ratingDelta: number;
  timestamp?: Date;
}

export type { OtaTelemetryInput };
export { BucketTarget };
export type { BucketTarget as BucketTargetType };

export class InfluxService {
  private client: InfluxDB;
  private metricsWriteApi: WriteApi;
  private complianceWriteApi: WriteApi;
  private queryApi: QueryApi;
  private config: InfluxDBConfig;
  private metricsDiskQueue: InfluxDiskQueue | null = null;
  private complianceDiskQueue: InfluxDiskQueue | null = null;

  deviceMetrics: DeviceMetricsRepo;
  deviceOtaEvents: DeviceOtaEventsRepo;
  instagramAudit: InstagramAuditRepo;
  webhookAudit: WebhookAuditRepo;
  pkiAudit: PkiAuditRepo;
  ctLog: CtLogRepo;
  otaTelemetry: OtaTelemetryRepo;

  private resolveBucket(target: BucketTarget): string {
    return target === BucketTarget.COMPLIANCE ? this.config.complianceBucket : this.config.bucket;
  }

  constructor(config: InfluxDBConfig) {
    this.config = config;

    this.client = new InfluxDB({
      url: this.config.url,
      token: this.config.token
    });

    this.metricsWriteApi = this.client.getWriteApi(this.config.org, this.config.bucket, 'ns', {
      batchSize: this.config.clientBatchSize,
      flushInterval: this.config.clientFlushIntervalMs,
      maxRetries: 3,
      maxBufferLines: 50_000
    });
    this.complianceWriteApi = this.client.getWriteApi(this.config.org, this.config.complianceBucket, 'ns', {
      batchSize: this.config.clientBatchSize,
      flushInterval: this.config.clientFlushIntervalMs,
      maxRetries: 5,
      maxBufferLines: 50_000
    });
    this.queryApi = this.client.getQueryApi(this.config.org);

    this.metricsWriteApi.useDefaultTags({ service: 'mqtt-publisher-lite' });
    this.complianceWriteApi.useDefaultTags({ service: 'mqtt-publisher-lite' });

    if (config.diskQueueEnabled) {
      const metricsQueuePath = `${config.diskQueuePath}.metrics`;
      this.metricsDiskQueue = new InfluxDiskQueue({
        queuePath: metricsQueuePath,
        flushIntervalMs: config.diskQueueFlushMs,
        batchMax: config.diskQueueBatchMax,
        maxLinesPerFile: config.diskQueueMaxLinesPerFile,
        syncOnAppend: config.diskQueueSyncOnAppend
      });
      this.metricsDiskQueue.start(async (lines) => {
        if (lines.length === 0) return;
        this.logInfluxBatchFlush(lines, 'metrics_disk_queue_worker');
        this.metricsWriteApi.writeRecords(lines);
        await this.metricsWriteApi.flush();
      });

      const complianceQueuePath = `${config.diskQueuePath}.compliance`;
      this.complianceDiskQueue = new InfluxDiskQueue({
        queuePath: complianceQueuePath,
        flushIntervalMs: config.diskQueueFlushMs,
        batchMax: config.diskQueueBatchMax,
        maxLinesPerFile: config.diskQueueMaxLinesPerFile,
        syncOnAppend: true
      });
      this.complianceDiskQueue.start(async (lines) => {
        if (lines.length === 0) return;
        this.logInfluxBatchFlush(lines, 'compliance_disk_queue_worker');
        this.complianceWriteApi.writeRecords(lines);
        await this.complianceWriteApi.flush();
      });
    }

    this.deviceMetrics = new DeviceMetricsRepo(this.config, this.metricsWriteApi, this.metricsDiskQueue);
    this.deviceOtaEvents = new DeviceOtaEventsRepo(this.config, this.metricsWriteApi, this.metricsDiskQueue);
    this.instagramAudit = new InstagramAuditRepo(this.config, this.metricsWriteApi, this.metricsDiskQueue);
    this.webhookAudit = new WebhookAuditRepo(this.config, this.metricsWriteApi, this.metricsDiskQueue);
    this.pkiAudit = new PkiAuditRepo(this.config, this.complianceWriteApi, this.complianceDiskQueue);
    this.ctLog = new CtLogRepo(this.config, this.complianceWriteApi, this.complianceDiskQueue);
    this.otaTelemetry = new OtaTelemetryRepo(this.config, this.metricsWriteApi, this.metricsDiskQueue);
  }

  private logInfluxBatchFlush(lines: string[], source: string): void {
    if (!this.config.logWrites || lines.length === 0) return;
    logger.info('InfluxDB batch flush', { source, count: lines.length, lines });
  }

  async writeDeviceMetrics(deviceId: string, metrics: DeviceMetrics): Promise<void> {
    await this.deviceMetrics.write({ deviceId, metrics });
  }

  async writeDeviceOtaEvent(input: DeviceOtaEventInput): Promise<void> {
    await this.deviceOtaEvents.write(input);
  }

  async writeSocialMetrics(platform: string, userId: string, metrics: SocialMetrics): Promise<void> {
    await this.deviceMetrics.writeSocialMetrics(platform, userId, metrics as unknown as Record<string, unknown>);
  }

  async writeSystemMetrics(metrics: SystemMetrics): Promise<void> {
    await this.deviceMetrics.writeSystemMetrics(metrics);
  }

  async writeInstagramFetchAudit(
    input: InstagramFetchAuditInfluxInput,
    opts?: { flush?: boolean }
  ): Promise<void> {
    await this.instagramAudit.write(input);
  }

  async writeInstagramFollowersGauge(
    deviceId: string,
    instagramAccountId: string,
    followers: number,
    timestamp?: Date,
    opts?: { flush?: boolean; mediaCount?: number }
  ): Promise<void> {
    await this.instagramAudit.writeFollowersGauge(deviceId, instagramAccountId, followers, timestamp, opts?.mediaCount);
  }

  async writeMilestoneCrossed(
    input: MilestoneCrossedInfluxInput,
    opts?: { flush?: boolean }
  ): Promise<void> {
    await this.instagramAudit.writeMilestoneCrossed(input);
  }

  /** @deprecated Use writeMilestoneCrossed with platform=instagram */
  async writeInstagramMilestoneCrossed(
    input: InstagramMilestoneCrossedInfluxInput,
    opts?: { flush?: boolean }
  ): Promise<void> {
    await this.instagramAudit.writeInstagramMilestoneCrossed(input);
  }

  async writeWebhookReceived(
    input: WebhookReceivedInfluxInput,
    opts?: { flush?: boolean }
  ): Promise<void> {
    await this.webhookAudit.write(input);
  }

  async writeWebhookDeviceResolution(
    input: WebhookDeviceResolutionInfluxInput,
    opts?: { flush?: boolean }
  ): Promise<void> {
    await this.webhookAudit.writeDeviceResolution(input);
  }

  async writeWebhookMqttDelivery(
    input: WebhookMqttDeliveryInfluxInput,
    opts?: { flush?: boolean }
  ): Promise<void> {
    await this.webhookAudit.writeMqttDelivery(input);
  }

  async writeInstagramMqttDelivery(
    input: InstagramMqttDeliveryInfluxInput,
    opts?: { flush?: boolean }
  ): Promise<void> {
    await this.instagramAudit.writeMqttDelivery(input);
  }

  async writeInstagramCircuitEvent(
    input: InstagramCircuitEventInfluxInput,
    opts?: { flush?: boolean }
  ): Promise<void> {
    await this.instagramAudit.writeCircuitEvent(input);
  }

  async writeProfileBaseline(
    input: ProfileBaselineInfluxInput,
    opts?: { flush?: boolean }
  ): Promise<void> {
    await this.instagramAudit.writeProfileBaseline(input);
  }

  async writeVelocityWeekly(
    input: VelocityWeeklyInfluxInput,
    opts?: { flush?: boolean }
  ): Promise<void> {
    await this.instagramAudit.writeVelocityWeekly(input);
  }

  async writeGmbReviewSnapshot(
    input: GmbReviewSnapshotInfluxInput,
    opts?: { flush?: boolean }
  ): Promise<void> {
    await this.webhookAudit.writeGmbReviewSnapshot(input);
  }

  async writeGmbWebhookAudit(
    input: GmbWebhookAuditInfluxInput,
    opts?: { flush?: boolean }
  ): Promise<void> {
    await this.webhookAudit.writeGmbWebhookAudit(input);
  }

  async writeGmbVelocityWeekly(
    input: GmbVelocityWeeklyInfluxInput,
    opts?: { flush?: boolean }
  ): Promise<void> {
    await this.webhookAudit.writeGmbVelocityWeekly(input);
  }

  async writeOtaTelemetry(input: OtaTelemetryInput, opts?: { flush?: boolean }): Promise<void> {
    await this.otaTelemetry.write(input);
  }

  async writeInstagramAttentionE2eLatency(
    deviceId: string,
    triggerType: string,
    latencyMs: number,
    timestamp?: Date,
    opts?: { flush?: boolean }
  ): Promise<void> {
    await this.instagramAudit.writeAttentionE2eLatency(deviceId, triggerType, latencyMs, timestamp);
  }

  async flushWrites(): Promise<void> {
    const metricsDone = this.metricsDiskQueue
      ? this.metricsDiskQueue.flushNow()
      : this.metricsWriteApi.flush();
    const complianceDone = this.complianceDiskQueue
      ? this.complianceDiskQueue.flushNow()
      : this.complianceWriteApi.flush();
    await Promise.all([metricsDone, complianceDone]);
  }

  async queryDeviceMetrics(deviceId: string, startTime: string, endTime?: string): Promise<Record<string, unknown>[]> {
    try {
      const end = endTime || new Date().toISOString();
      const query = `
        from(bucket: "${this.resolveBucket(BucketTarget.METRICS)}")
          |> range(start: ${startTime}, stop: ${end})
          |> filter(fn: (r) => r._measurement == "device_metrics")
          |> filter(fn: (r) => r.device_id == "${deviceId}")
          |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
      `;
      const results: Record<string, unknown>[] = [];
      return new Promise((resolve, reject) => {
        this.queryApi.queryRows(query, {
          next(row, tableMeta) { results.push(tableMeta.toObject(row)); },
          error(error) { reject(error); },
          complete() { resolve(results); }
        });
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to query device metrics', { deviceId, error: errorMessage });
      throw error;
    }
  }

  async querySocialMetrics(platform: string, userId: string, startTime: string, endTime?: string): Promise<Record<string, unknown>[]> {
    try {
      const end = endTime || new Date().toISOString();
      const query = `
        from(bucket: "${this.resolveBucket(BucketTarget.METRICS)}")
          |> range(start: ${startTime}, stop: ${end})
          |> filter(fn: (r) => r._measurement == "social_metrics")
          |> filter(fn: (r) => r.platform == "${platform}")
          |> filter(fn: (r) => r.user_id == "${userId}")
          |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
      `;
      const results: Record<string, unknown>[] = [];
      return new Promise((resolve, reject) => {
        this.queryApi.queryRows(query, {
          next(row, tableMeta) { results.push(tableMeta.toObject(row)); },
          error(error) { reject(error); },
          complete() { resolve(results); }
        });
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to query social metrics', { platform, userId, error: errorMessage });
      throw error;
    }
  }

  async getLatestDeviceMetrics(deviceId: string): Promise<Record<string, unknown> | null> {
    try {
      const query = `
        from(bucket: "${this.resolveBucket(BucketTarget.METRICS)}")
          |> range(start: -1h)
          |> filter(fn: (r) => r._measurement == "device_metrics")
          |> filter(fn: (r) => r.device_id == "${deviceId}")
          |> last()
          |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
      `;
      const results: Record<string, unknown>[] = [];
      return new Promise((resolve, reject) => {
        this.queryApi.queryRows(query, {
          next(row, tableMeta) { results.push(tableMeta.toObject(row)); },
          error(error) { reject(error); },
          complete() { resolve(results.length > 0 ? results[0] : null); }
        });
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to get latest device metrics', { deviceId, error: errorMessage });
      throw error;
    }
  }

  async queryFlux<T = Record<string, unknown>>(fluxQuery: string): Promise<T[]> {
    const results: T[] = [];
    return new Promise((resolve, reject) => {
      this.queryApi.queryRows(fluxQuery, {
        next(row, tableMeta) { results.push(tableMeta.toObject(row) as T); },
        error(error) { reject(error); },
        complete() { resolve(results); }
      });
    });
  }

  async queryInstagramMetrics(
    deviceId: string,
    startTime: string,
    endTime?: string
  ): Promise<Record<string, unknown>[]> {
    const end = endTime || new Date().toISOString();
    return this.queryFlux(`
      from(bucket: "${this.config.bucket}")
        |> range(start: ${startTime}, stop: ${end})
        |> filter(fn: (r) => r._measurement == "instagram_metrics")
        |> filter(fn: (r) => r.device_id == "${deviceId}")
        |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> sort(columns: ["_time"])
    `);
  }

  async queryInstagramAudit(
    deviceId: string,
    startTime: string,
    endTime?: string
  ): Promise<Record<string, unknown>[]> {
    const end = endTime || new Date().toISOString();
    return this.queryFlux(`
      from(bucket: "${this.config.bucket}")
        |> range(start: ${startTime}, stop: ${end})
        |> filter(fn: (r) => r._measurement == "instagram_fetch_audit")
        |> filter(fn: (r) => r.device_id == "${deviceId}")
        |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> sort(columns: ["_time"], desc: true)
    `);
  }

  async queryMilestones(
    deviceId: string,
    platform?: string,
    startTime?: string,
    endTime?: string
  ): Promise<Record<string, unknown>[]> {
    const start = startTime || '-90d';
    const end = endTime || new Date().toISOString();
    let flux = `
      from(bucket: "${this.config.bucket}")
        |> range(start: ${start}, stop: ${end})
        |> filter(fn: (r) => r._measurement == "milestone_crossed")
        |> filter(fn: (r) => r.device_id == "${deviceId}")
    `;
    if (platform) {
      flux += `  |> filter(fn: (r) => r.platform == "${platform}")\n`;
    }
    flux += `  |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> sort(columns: ["_time"], desc: true)`;
    return this.queryFlux(flux);
  }

  async queryProfileBaseline(
    deviceId: string,
    platform: string
  ): Promise<Record<string, unknown> | null> {
    const results = await this.queryFlux(`
      from(bucket: "${this.config.bucket}")
        |> range(start: 0)
        |> filter(fn: (r) => r._measurement == "profile_baseline")
        |> filter(fn: (r) => r.device_id == "${deviceId}")
        |> filter(fn: (r) => r.platform == "${platform}")
        |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> sort(columns: ["_time"], desc: true)
        |> limit(n: 1)
    `);
    return results.length > 0 ? results[0] : null;
  }

  async queryVelocityWeekly(
    deviceId: string,
    platform: string,
    weekOfYear?: string
  ): Promise<Record<string, unknown>[]> {
    let flux = `
      from(bucket: "${this.config.bucket}")
        |> range(start: -90d)
        |> filter(fn: (r) => r._measurement == "velocity_weekly")
        |> filter(fn: (r) => r.device_id == "${deviceId}")
        |> filter(fn: (r) => r.platform == "${platform}")
    `;
    if (weekOfYear) {
      flux += `  |> filter(fn: (r) => r.week_of_year == "${weekOfYear}")\n`;
    }
    flux += `  |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> sort(columns: ["_time"], desc: true)`;
    return this.queryFlux(flux);
  }

  async queryWebhookEvents(
    locationId: string,
    startTime: string,
    endTime?: string
  ): Promise<Record<string, unknown>[]> {
    const end = endTime || new Date().toISOString();
    return this.queryFlux(`
      from(bucket: "${this.config.bucket}")
        |> range(start: ${startTime}, stop: ${end})
        |> filter(fn: (r) => r._measurement == "webhook_received")
        |> filter(fn: (r) => r.location_id == "${locationId}")
        |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> sort(columns: ["_time"], desc: true)
    `);
  }

  async queryWebhookMqttDeliveries(
    deviceId: string,
    startTime: string,
    endTime?: string
  ): Promise<Record<string, unknown>[]> {
    const end = endTime || new Date().toISOString();
    return this.queryFlux(`
      from(bucket: "${this.config.bucket}")
        |> range(start: ${startTime}, stop: ${end})
        |> filter(fn: (r) => r._measurement == "webhook_mqtt_delivery")
        |> filter(fn: (r) => r.device_id == "${deviceId}")
        |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> sort(columns: ["_time"], desc: true)
    `);
  }

  async queryInstagramMqttDeliveries(
    deviceId: string,
    startTime: string,
    endTime?: string
  ): Promise<Record<string, unknown>[]> {
    const end = endTime || new Date().toISOString();
    return this.queryFlux(`
      from(bucket: "${this.config.bucket}")
        |> range(start: ${startTime}, stop: ${end})
        |> filter(fn: (r) => r._measurement == "instagram_mqtt_delivery")
        |> filter(fn: (r) => r.device_id == "${deviceId}")
        |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> sort(columns: ["_time"], desc: true)
    `);
  }

  async queryGmbReviewSnapshots(
    locationId: string,
    startTime: string,
    endTime?: string
  ): Promise<Record<string, unknown>[]> {
    const end = endTime || new Date().toISOString();
    return this.queryFlux(`
      from(bucket: "${this.config.bucket}")
        |> range(start: ${startTime}, stop: ${end})
        |> filter(fn: (r) => r._measurement == "gmb_review_snapshot")
        |> filter(fn: (r) => r.location_id == "${locationId}")
        |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> sort(columns: ["_time"], desc: true)
    `);
  }

  async queryGmbWebhookAudits(
    locationId: string,
    startTime: string,
    endTime?: string
  ): Promise<Record<string, unknown>[]> {
    const end = endTime || new Date().toISOString();
    return this.queryFlux(`
      from(bucket: "${this.config.bucket}")
        |> range(start: ${startTime}, stop: ${end})
        |> filter(fn: (r) => r._measurement == "gmb_webhook_audit")
        |> filter(fn: (r) => r.location_id == "${locationId}")
        |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> sort(columns: ["_time"], desc: true)
    `);
  }

  async queryGmbVelocityWeekly(
    locationId: string,
    weekOfYear?: string
  ): Promise<Record<string, unknown>[]> {
    let flux = `
      from(bucket: "${this.config.bucket}")
        |> range(start: -90d)
        |> filter(fn: (r) => r._measurement == "gmb_velocity_weekly")
        |> filter(fn: (r) => r.location_id == "${locationId}")
    `;
    if (weekOfYear) {
      flux += `  |> filter(fn: (r) => r.week_of_year == "${weekOfYear}")\n`;
    }
    flux += `  |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> sort(columns: ["_time"], desc: true)`;
    return this.queryFlux(flux);
  }

  async queryInstagramCircuitEvents(
    startTime: string,
    endTime?: string
  ): Promise<Record<string, unknown>[]> {
    const end = endTime || new Date().toISOString();
    return this.queryFlux(`
      from(bucket: "${this.config.bucket}")
        |> range(start: ${startTime}, stop: ${end})
        |> filter(fn: (r) => r._measurement == "instagram_circuit_event")
        |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> sort(columns: ["_time"], desc: true)
    `);
  }

  async queryInstagramAttentionE2e(
    deviceId: string,
    startTime: string,
    endTime?: string
  ): Promise<Record<string, unknown>[]> {
    const end = endTime || new Date().toISOString();
    return this.queryFlux(`
      from(bucket: "${this.config.bucket}")
        |> range(start: ${startTime}, stop: ${end})
        |> filter(fn: (r) => r._measurement == "instagram_attention_e2e")
        |> filter(fn: (r) => r.device_id == "${deviceId}")
        |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> sort(columns: ["_time"], desc: true)
    `);
  }

  async queryRateLimitEvents(
    startTime: string,
    endTime?: string,
    limitType?: string
  ): Promise<Record<string, unknown>[]> {
    const end = endTime || new Date().toISOString();
    let flux = `
      from(bucket: "${this.config.bucket}")
        |> range(start: ${startTime}, stop: ${end})
        |> filter(fn: (r) => r._measurement == "rate_limit_events")
    `;
    if (limitType) {
      flux += `  |> filter(fn: (r) => r.limit_type == "${limitType}")\n`;
    }
    flux += `  |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> sort(columns: ["_time"], desc: true)`;
    return this.queryFlux(flux);
  }

  async writeAuditEvent(data: {
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
  }): Promise<void> {
    await this.pkiAudit.write(data);
  }

  async writeRateLimitEvent(data: {
    limitType: string;
    endpoint: string;
    ip: string;
    count: number;
    limit: number;
    deviceId?: string;
  }): Promise<void> {
    await this.deviceMetrics.writeRateLimitEvent(data);
  }

  async queryAuditEvents(startTime: string, endTime?: string, eventType?: string): Promise<Record<string, unknown>[]> {
    try {
      const end = endTime || new Date().toISOString();
      let fluxQuery = `
        from(bucket: "${this.resolveBucket(BucketTarget.COMPLIANCE)}")
          |> range(start: ${startTime}, stop: ${end})
          |> filter(fn: (r) => r._measurement == "pki_audit")
      `;
      if (eventType) {
        fluxQuery += `  |> filter(fn: (r) => r.event == "${eventType}")\n`;
      }
      fluxQuery += `  |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")`;
      const results: Record<string, unknown>[] = [];
      return new Promise((resolve, reject) => {
        this.queryApi.queryRows(fluxQuery, {
          next(row, tableMeta) { results.push(tableMeta.toObject(row)); },
          error(error) { reject(error); },
          complete() { resolve(results); }
        });
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to query PKI audit events', { error: errorMessage });
      throw error;
    }
  }

  async writeTransparencyEntry(data: {
    index: number;
    leafHash: string;
    rootHash: string;
    inclusionProof: string;
    certFingerprint: string;
    serialNumber: string;
    cn: string;
    deviceId: string;
    issuedAt: Date;
  }): Promise<void> {
    await this.ctLog.write(data);
  }

  async writeOtaReleaseEntry(data: {
    index: number;
    leafHash: string;
    rootHash: string;
    inclusionProof: string;
    version: string;
    sha256: string;
    objectKey: string;
    keyFingerprint: string;
    releasedAt: Date;
  }): Promise<void> {
    await this.ctLog.writeOtaReleaseEntry(data);
  }

  async queryOtaReleaseLeaves(): Promise<Array<{ index: number; leafHash: string }>> {
    try {
      const fluxQuery = `
        from(bucket: "${this.resolveBucket(BucketTarget.COMPLIANCE)}")
          |> range(start: 0)
          |> filter(fn: (r) => r._measurement == "ota_release_log")
          |> filter(fn: (r) => r._field == "leaf_hash" or r._field == "index")
          |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
          |> sort(columns: ["index"])
      `;
      const results: Array<{ index: number; leafHash: string }> = [];
      return new Promise((resolve, reject) => {
        this.queryApi.queryRows(fluxQuery, {
          next(row, tableMeta) {
            const obj = tableMeta.toObject(row);
            results.push({
              index: typeof obj.index === 'number' ? obj.index : parseInt(String(obj.index), 10),
              leafHash: String(obj.leaf_hash || '')
            });
          },
          error(error) { reject(error); },
          complete() { resolve(results); }
        });
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to query OTA release log leaves', { error: errorMessage });
      return [];
    }
  }

  async queryTransparencyLeaves(): Promise<Array<{ index: number; leafHash: string }>> {
    try {
      const fluxQuery = `
        from(bucket: "${this.resolveBucket(BucketTarget.COMPLIANCE)}")
          |> range(start: 0)
          |> filter(fn: (r) => r._measurement == "ct_log")
          |> filter(fn: (r) => r._field == "leaf_hash" or r._field == "index")
          |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
          |> sort(columns: ["index"])
      `;
      const results: Array<{ index: number; leafHash: string }> = [];
      return new Promise((resolve, reject) => {
        this.queryApi.queryRows(fluxQuery, {
          next(row, tableMeta) {
            const obj = tableMeta.toObject(row);
            results.push({
              index: typeof obj.index === 'number' ? obj.index : parseInt(String(obj.index), 10),
              leafHash: String(obj.leaf_hash || '')
            });
          },
          error(error) { reject(error); },
          complete() { resolve(results); }
        });
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to query CT log leaves', { error: errorMessage });
      return [];
    }
  }

  async queryLatestAuditEntry(): Promise<{ sequence: number; hash: string } | null> {
    try {
      const fluxQuery = `
        from(bucket: "${this.resolveBucket(BucketTarget.COMPLIANCE)}")
          |> range(start: 0)
          |> filter(fn: (r) => r._measurement == "pki_audit")
          |> filter(fn: (r) => r._field == "sequence" or r._field == "hash")
          |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
          |> sort(columns: ["_time"], desc: true)
          |> limit(n: 1)
      `;
      return new Promise((resolve, reject) => {
        let result: { sequence: number; hash: string } | null = null;
        this.queryApi.queryRows(fluxQuery, {
          next(row, tableMeta) {
            const obj = tableMeta.toObject(row);
            if (obj.sequence !== undefined && obj.hash) {
              result = {
                sequence: typeof obj.sequence === 'number' ? obj.sequence : parseInt(String(obj.sequence), 10),
                hash: String(obj.hash)
              };
            }
          },
          error(error) { reject(error); },
          complete() { resolve(result); }
        });
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to query latest audit entry from InfluxDB', { error: errorMessage });
      return null;
    }
  }

  async queryAuditChain(startTime?: string): Promise<Array<{
    sequence: number; hash: string; previousHash: string;
    event: string; timestamp: string;
  }>> {
    try {
      const start = startTime || '0';
      const fluxQuery = `
        from(bucket: "${this.resolveBucket(BucketTarget.COMPLIANCE)}")
          |> range(start: ${start})
          |> filter(fn: (r) => r._measurement == "pki_audit")
          |> filter(fn: (r) => r._field == "sequence" or r._field == "hash" or r._field == "previous_hash")
          |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
          |> sort(columns: ["_time"])
      `;
      const results: Array<{
        sequence: number; hash: string; previousHash: string;
        event: string; timestamp: string;
      }> = [];
      return new Promise((resolve, reject) => {
        this.queryApi.queryRows(fluxQuery, {
          next(row, tableMeta) {
            const obj = tableMeta.toObject(row);
            results.push({
              sequence: typeof obj.sequence === 'number' ? obj.sequence : parseInt(String(obj.sequence), 10),
              hash: String(obj.hash || ''),
              previousHash: String(obj.previous_hash || ''),
              event: String(obj.event || ''),
              timestamp: String(obj._time || '')
            });
          },
          error(error) { reject(error); },
          complete() { resolve(results); }
        });
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to query audit chain from InfluxDB', { error: errorMessage });
      return [];
    }
  }

  async healthCheck(): Promise<boolean> {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const { httpGet } = await import('../utils/httpProbe');

    const rawBase = this.config.url.replace(/\/+$/, '');
    const u = new URL(`${rawBase}/health`);
    if (u.hostname === 'localhost') u.hostname = '127.0.0.1';

    const isLoopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost';

    const retriesEnv = parseInt(process.env.INFLUXDB_HEALTH_RETRIES?.trim() || '', 10);
    const maxAttempts =
      Number.isFinite(retriesEnv) && retriesEnv >= 1
        ? Math.min(retriesEnv, 10)
        : isLoopback ? 1 : 3;

    const delayEnv = parseInt(process.env.INFLUXDB_HEALTH_RETRY_DELAY_MS?.trim() || '', 10);
    const retryDelayMs = Number.isFinite(delayEnv) && delayEnv >= 0 ? delayEnv : 2500;

    const healthTimeoutEnv = parseInt(process.env.INFLUXDB_HEALTH_TIMEOUT_MS?.trim() || '', 10);
    const healthTimeoutMs =
      Number.isFinite(healthTimeoutEnv) && healthTimeoutEnv > 0
        ? healthTimeoutEnv
        : isLoopback ? 3000 : 20000;

    let healthOk = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const body = await httpGet(`${rawBase}/health`, { timeout: healthTimeoutMs });
        const payload = body.json as { status?: string; message?: string };
        if (body.statusCode >= 200 && body.statusCode < 300 && (!payload.status || payload.status === 'pass')) {
          healthOk = true;
          if (attempt > 1) {
            logger.info('InfluxDB /health OK after retry', { attempt, maxAttempts });
          }
          break;
        }
        const retryableHttp =
          body.statusCode === 0 || body.statusCode >= 500 || body.statusCode === 429;
        if (!retryableHttp || attempt === maxAttempts) {
          logger.warn('InfluxDB /health HTTP error', {
            status: body.statusCode,
            bodyStatus: payload.status,
            message: payload.message
          });
          if (body.statusCode >= 200 && body.statusCode < 300 && payload.status && payload.status !== 'pass') {
            logger.warn('InfluxDB /health reports non-pass', { status: payload.status, message: payload.message });
          }
          if (!retryableHttp) return false;
          if (attempt === maxAttempts) return false;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('InfluxDB /health attempt failed', {
          attempt, maxAttempts, url: this.config.url, error: msg
        });
        if (attempt === maxAttempts) {
          logger.warn('InfluxDB /health unreachable after retries', { url: this.config.url, error: msg });
          return false;
        }
      }
      if (!healthOk && attempt < maxAttempts) {
        await sleep(retryDelayMs);
      }
    }

    if (!healthOk) return false;

    const org = this.config.org;
    const apiProbeEnv = parseInt(process.env.INFLUXDB_API_PROBE_TIMEOUT_MS?.trim() || '', 10);
    const fluxFallbackEnv = parseInt(process.env.INFLUXDB_FLUX_PROBE_TIMEOUT_MS?.trim() || '', 10);
    const apiTimeoutMs =
      Number.isFinite(apiProbeEnv) && apiProbeEnv > 0
        ? apiProbeEnv
        : Number.isFinite(fluxFallbackEnv) && fluxFallbackEnv > 0
          ? fluxFallbackEnv
          : isLoopback ? 8000 : 20000;

    logger.info('InfluxDB /health OK; verifying API token and both buckets', {
      apiTimeoutMs, org,
      metricsBucket: this.config.bucket,
      complianceBucket: this.config.complianceBucket,
      maxAttempts
    });

    const verifyBucket = async (bucketName: string, label: string): Promise<boolean> => {
      const bucketsUrl = `${rawBase}/api/v2/buckets?org=${encodeURIComponent(org)}`;
      const token = this.config.token?.trim() ?? '';

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const res = await httpGet(bucketsUrl, {
            timeout: apiTimeoutMs,
            headers: { Authorization: `Token ${token}`, Accept: 'application/json' }
          });

          if (res.statusCode === 401 || res.statusCode === 403) {
            logger.warn(`InfluxDB buckets API rejected token (${label})`, { status: res.statusCode, org });
            return false;
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            const retryable = res.statusCode >= 500 || res.statusCode === 429;
            if (retryable && attempt < maxAttempts) {
              logger.warn(`InfluxDB buckets API transient error (${label}); retrying`, {
                status: res.statusCode, attempt, maxAttempts
              });
              await sleep(retryDelayMs);
              continue;
            }
            logger.warn(`InfluxDB buckets API HTTP error (${label})`, {
              status: res.statusCode, org, message: res.json?.message || res.json?.code
            });
            return false;
          }

          const buckets = Array.isArray(res.json?.buckets) ? res.json.buckets : [];
          const hasBucket = buckets.some((b: { name?: string }) => b?.name === bucketName);
          if (!hasBucket) {
            logger.warn(`InfluxDB: bucket "${bucketName}" not found for org (check INFLUXDB_${label.toUpperCase()}_BUCKET)`, {
              org, bucket: bucketName,
              bucketNames: buckets.map((b: { name?: string }) => b?.name).filter(Boolean)
            });
            return false;
          }

          if (attempt > 1) {
            logger.info(`InfluxDB ${label} bucket OK after retry`, { attempt, maxAttempts });
          }
          return true;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`InfluxDB buckets API attempt failed (${label})`, { attempt, maxAttempts, error: msg });
          if (attempt === maxAttempts) {
            logger.warn(`InfluxDB buckets API unreachable after retries (${label})`, {
              url: this.config.url, org, bucket: bucketName, error: msg
            });
            return false;
          }
          await sleep(retryDelayMs);
        }
      }
      return false;
    };

    const metricsOk = await verifyBucket(this.config.bucket, 'metrics');
    const complianceOk = await verifyBucket(this.config.complianceBucket, 'compliance');
    return metricsOk && complianceOk;
  }

  async close(): Promise<void> {
    try {
      const queueShutdowns: Promise<void>[] = [];
      if (this.metricsDiskQueue) {
        queueShutdowns.push(
          this.metricsDiskQueue.shutdown(async (lines) => {
            if (lines.length === 0) return;
            this.logInfluxBatchFlush(lines, 'metrics_disk_queue_shutdown');
            this.metricsWriteApi.writeRecords(lines);
            await this.metricsWriteApi.flush();
          })
        );
      }
      if (this.complianceDiskQueue) {
        queueShutdowns.push(
          this.complianceDiskQueue.shutdown(async (lines) => {
            if (lines.length === 0) return;
            this.logInfluxBatchFlush(lines, 'compliance_disk_queue_shutdown');
            this.complianceWriteApi.writeRecords(lines);
            await this.complianceWriteApi.flush();
          })
        );
      }
      await Promise.all(queueShutdowns);
      this.metricsDiskQueue = null;
      this.complianceDiskQueue = null;

      await Promise.all([
        this.metricsWriteApi.close(),
        this.complianceWriteApi.close()
      ]);
      logger.info('InfluxDB connections closed');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error closing InfluxDB connection', { error: errorMessage });
    }
  }
}

let influxServiceInstance: InfluxService | null = null;

export function createInfluxService(config: InfluxDBConfig): InfluxService {
  influxServiceInstance = new InfluxService(config);
  return influxServiceInstance;
}

export function getInfluxService(): InfluxService | null {
  return influxServiceInstance;
}

export async function resetInfluxService(): Promise<void> {
  if (!influxServiceInstance) return;
  try {
    await influxServiceInstance.close();
  } catch {
    /* ignore */
  }
  influxServiceInstance = null;
}
