/**
 * InfluxDB Service for mqtt-publisher-lite
 * Time-series metrics storage for device, social media, and system metrics.
 *
 * Dual-bucket architecture:
 *   metrics      — operational time-series (ig_metrics, gmb_metrics, mqtt_delivery, etc.)
 *   pki_compliance — PKI hash chain + CT log (pki_audit, ct_log, device_state_log)
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
import { IgMetricsRepo, type IgMetricsInput } from '../storage/influx/repositories/IgMetricsRepo';
import { IgMilestoneRepo, type IgMilestoneInput } from '../storage/influx/repositories/IgMilestoneRepo';
import { GmbMetricsRepo, type GmbMetricsInput } from '../storage/influx/repositories/GmbMetricsRepo';
import { GmbMilestoneRepo, type GmbMilestoneInput } from '../storage/influx/repositories/GmbMilestoneRepo';
import { MqttDeliveryRepo, type MqttDeliveryInput } from '../storage/influx/repositories/MqttDeliveryRepo';
import { DeviceActiveRepo, type DeviceActiveInput } from '../storage/influx/repositories/DeviceActiveRepo';
import { DeviceStateLogRepo, type DeviceStateLogInput } from '../storage/influx/repositories/DeviceStateLogRepo';
import { OtaEventsRepo, type OtaEventsInput } from '../storage/influx/repositories/OtaEventsRepo';
import { InstagramAuditRepo } from '../storage/influx/repositories/InstagramAuditRepo';
import { WebhookAuditRepo } from '../storage/influx/repositories/WebhookAuditRepo';
import { PkiAuditRepo, type PkiAuditInput } from '../storage/influx/repositories/PkiAuditRepo';
import { CtLogRepo, type TransparencyEntryInput, type OtaReleaseEntryInput } from '../storage/influx/repositories/CtLogRepo';

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
  apiEndpoint?: string;
  primaryResponseSha256?: string;
  detailsResponseSha256?: string;
  timestamp?: Date;
}

export interface ProfileBaselineInfluxInput {
  deviceId: string;
  platform: 'instagram' | 'gmb';
  followers?: number;
  reviews?: number;
  rating?: number;
  locationId?: string;
  connectedAt: Date;
  timestamp?: Date;
}

export interface GmbWebhookAuditInfluxInput {
  deviceId?: string;
  locationId: string;
  eventType: string;
  webhookId?: string;
  receivedAt: string;
  processedAt?: string;
  processingMs?: number;
  verified: boolean;
  signatureValid: boolean;
  payloadSizeBytes: number;
  payloadSha256: string;
  resolvedDeviceCount?: number;
  correlationId?: string;
  errorMessage?: string;
  timestamp?: Date;
}

export type { OtaEventsInput };
export type {
  IgMetricsInput,
  IgMilestoneInput,
  GmbMetricsInput,
  GmbMilestoneInput,
  MqttDeliveryInput,
  DeviceActiveInput,
  DeviceStateLogInput,
  PkiAuditInput,
  TransparencyEntryInput,
  OtaReleaseEntryInput,
};
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

  igMetrics: IgMetricsRepo;
  igMilestone: IgMilestoneRepo;
  gmbMetrics: GmbMetricsRepo;
  gmbMilestone: GmbMilestoneRepo;
  mqttDelivery: MqttDeliveryRepo;
  deviceActive: DeviceActiveRepo;
  deviceStateLog: DeviceStateLogRepo;
  otaEvents: OtaEventsRepo;
  instagramAudit: InstagramAuditRepo;
  webhookAudit: WebhookAuditRepo;
  pkiAudit: PkiAuditRepo;
  ctLog: CtLogRepo;

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

    this.igMetrics = new IgMetricsRepo(this.config, this.metricsWriteApi, this.metricsDiskQueue);
    this.igMilestone = new IgMilestoneRepo(this.config, this.metricsWriteApi, this.metricsDiskQueue);
    this.gmbMetrics = new GmbMetricsRepo(this.config, this.metricsWriteApi, this.metricsDiskQueue);
    this.gmbMilestone = new GmbMilestoneRepo(this.config, this.metricsWriteApi, this.metricsDiskQueue);
    this.mqttDelivery = new MqttDeliveryRepo(this.config, this.metricsWriteApi, this.metricsDiskQueue);
    this.deviceActive = new DeviceActiveRepo(this.config, this.metricsWriteApi, this.metricsDiskQueue);
    this.deviceStateLog = new DeviceStateLogRepo(this.config, this.complianceWriteApi, this.complianceDiskQueue);
    this.otaEvents = new OtaEventsRepo(this.config, this.metricsWriteApi, this.metricsDiskQueue);
    this.instagramAudit = new InstagramAuditRepo(this.config, this.metricsWriteApi, this.metricsDiskQueue);
    this.webhookAudit = new WebhookAuditRepo(this.config, this.metricsWriteApi, this.metricsDiskQueue);
    this.pkiAudit = new PkiAuditRepo(this.config, this.complianceWriteApi, this.complianceDiskQueue);
    this.ctLog = new CtLogRepo(this.config, this.complianceWriteApi, this.complianceDiskQueue);
  }

  private logInfluxBatchFlush(lines: string[], source: string): void {
    if (!this.config.logWrites || lines.length === 0) return;
    logger.info('InfluxDB batch flush', { source, count: lines.length, lines });
  }

  // ── Metrics writes ─────────────────────────────────────────────────

  async writeIgMetrics(input: IgMetricsInput, opts?: { flush?: boolean }): Promise<void> {
    await this.igMetrics.write(input);
  }

  async writeIgMilestone(input: IgMilestoneInput, opts?: { flush?: boolean }): Promise<void> {
    await this.igMilestone.write(input);
  }

  async writeGmbMetrics(input: GmbMetricsInput, opts?: { flush?: boolean }): Promise<void> {
    await this.gmbMetrics.write(input);
  }

  async writeGmbMilestone(input: GmbMilestoneInput, opts?: { flush?: boolean }): Promise<void> {
    await this.gmbMilestone.write(input);
  }

  async writeMqttDelivery(input: MqttDeliveryInput, opts?: { flush?: boolean }): Promise<void> {
    await this.mqttDelivery.write(input);
  }

  async writeDeviceActive(input: DeviceActiveInput): Promise<void> {
    await this.deviceActive.write(input);
  }

  async writeDeviceStateLog(input: DeviceStateLogInput): Promise<void> {
    await this.deviceStateLog.write(input);
  }

  async writeOtaEvent(input: OtaEventsInput): Promise<void> {
    await this.otaEvents.write(input);
  }

  // ── Audit writes ───────────────────────────────────────────────────

  async writeInstagramFetchAudit(
    input: InstagramFetchAuditInfluxInput,
    opts?: { flush?: boolean }
  ): Promise<void> {
    await this.instagramAudit.write(input);
  }

  async writeProfileBaseline(
    input: ProfileBaselineInfluxInput,
    opts?: { flush?: boolean }
  ): Promise<void> {
    await this.instagramAudit.writeProfileBaseline(input);
  }

  async writeGmbWebhookAudit(
    input: GmbWebhookAuditInfluxInput,
    opts?: { flush?: boolean }
  ): Promise<void> {
    await this.webhookAudit.writeGmbWebhookAudit(input);
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

  // ── Compliance writes ──────────────────────────────────────────────

  async writeAuditEvent(data: {
    event: string;
    deviceId: string;
    userId?: string;
    serialNumber?: string;
    certificateFingerprint?: string;
    sequence?: number;
    hash?: string;
    previousHash?: string;
    hashPreimage?: string;
    details?: Record<string, unknown>;
  }): Promise<void> {
    await this.pkiAudit.write(data);
  }

  async writeTransparencyEntry(data: TransparencyEntryInput): Promise<void> {
    await this.ctLog.write(data);
  }

  async writeOtaReleaseEntry(data: OtaReleaseEntryInput): Promise<void> {
    await this.ctLog.writeOtaReleaseEntry(data);
  }

  // ── Flush / close ─────────────────────────────────────────────────

  async flushWrites(): Promise<void> {
    const metricsDone = this.metricsDiskQueue
      ? this.metricsDiskQueue.flushNow()
      : this.metricsWriteApi.flush();
    const complianceDone = this.complianceDiskQueue
      ? this.complianceDiskQueue.flushNow()
      : this.complianceWriteApi.flush();
    await Promise.all([metricsDone, complianceDone]);
  }

  // ── Queries ────────────────────────────────────────────────────────

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

  async queryIgMetrics(
    deviceId: string,
    startTime: string,
    endTime?: string
  ): Promise<Record<string, unknown>[]> {
    const end = endTime || new Date().toISOString();
    return this.queryFlux(`
      from(bucket: "${this.config.bucket}")
        |> range(start: ${startTime}, stop: ${end})
        |> filter(fn: (r) => r._measurement == "ig_metrics")
        |> filter(fn: (r) => r.device_id == "${deviceId}")
        |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> sort(columns: ["_time"])
    `);
  }

  async queryIgMilestones(
    deviceId: string,
    startTime?: string,
    endTime?: string
  ): Promise<Record<string, unknown>[]> {
    const start = startTime || '-90d';
    const end = endTime || new Date().toISOString();
    return this.queryFlux(`
      from(bucket: "${this.config.bucket}")
        |> range(start: ${start}, stop: ${end})
        |> filter(fn: (r) => r._measurement == "ig_milestone")
        |> filter(fn: (r) => r.device_id == "${deviceId}")
        |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> sort(columns: ["_time"], desc: true)
    `);
  }

  async queryGmbMetrics(
    locationId: string,
    startTime: string,
    endTime?: string
  ): Promise<Record<string, unknown>[]> {
    const end = endTime || new Date().toISOString();
    return this.queryFlux(`
      from(bucket: "${this.config.bucket}")
        |> range(start: ${startTime}, stop: ${end})
        |> filter(fn: (r) => r._measurement == "gmb_metrics")
        |> filter(fn: (r) => r.location_id == "${locationId}")
        |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> sort(columns: ["_time"])
    `);
  }

  async queryGmbMilestones(
    locationId: string,
    startTime?: string,
    endTime?: string
  ): Promise<Record<string, unknown>[]> {
    const start = startTime || '-90d';
    const end = endTime || new Date().toISOString();
    return this.queryFlux(`
      from(bucket: "${this.config.bucket}")
        |> range(start: ${start}, stop: ${end})
        |> filter(fn: (r) => r._measurement == "gmb_milestone")
        |> filter(fn: (r) => r.location_id == "${locationId}")
        |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> sort(columns: ["_time"], desc: true)
    `);
  }

  async queryMqttDelivery(
    deviceId: string,
    platform: string,
    startTime: string,
    endTime?: string
  ): Promise<Record<string, unknown>[]> {
    const end = endTime || new Date().toISOString();
    return this.queryFlux(`
      from(bucket: "${this.config.bucket}")
        |> range(start: ${startTime}, stop: ${end})
        |> filter(fn: (r) => r._measurement == "mqtt_delivery")
        |> filter(fn: (r) => r.device_id == "${deviceId}")
        |> filter(fn: (r) => r.platform == "${platform}")
        |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> sort(columns: ["_time"], desc: true)
    `);
  }

  async queryDeviceActive(
    deviceId: string,
    startTime: string,
    endTime?: string
  ): Promise<Record<string, unknown>[]> {
    const end = endTime || new Date().toISOString();
    return this.queryFlux(`
      from(bucket: "${this.config.bucket}")
        |> range(start: ${startTime}, stop: ${end})
        |> filter(fn: (r) => r._measurement == "device_active")
        |> filter(fn: (r) => r.device_id == "${deviceId}")
        |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> sort(columns: ["_time"], desc: true)
    `);
  }

  async queryLatestDeviceStateEntry(
    deviceId: string
  ): Promise<{ sequence: number; hash: string } | null> {
    try {
      const fluxQuery = `
        from(bucket: "${this.resolveBucket(BucketTarget.COMPLIANCE)}")
          |> range(start: -3650d)
          |> filter(fn: (r) => r._measurement == "device_state_log")
          |> filter(fn: (r) => r.device_id == "${deviceId}")
          |> filter(fn: (r) => r._field == "hash" or r._field == "sequence")
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
      logger.error('Failed to query latest device state entry', { deviceId, error: errorMessage });
      return null;
    }
  }

  async queryLatestDeviceStateEntries(): Promise<Map<string, { sequence: number; hash: string }>> {
    try {
      const fluxQuery = `
        from(bucket: "${this.resolveBucket(BucketTarget.COMPLIANCE)}")
          |> range(start: -3650d)
          |> filter(fn: (r) => r._measurement == "device_state_log")
          |> filter(fn: (r) => r._field == "hash" or r._field == "sequence")
          |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
          |> group(columns: ["device_id"])
          |> sort(columns: ["_time"], desc: true)
          |> limit(n: 1)
      `;
      const results = new Map<string, { sequence: number; hash: string }>();
      return new Promise((resolve, reject) => {
        this.queryApi.queryRows(fluxQuery, {
          next(row, tableMeta) {
            const obj = tableMeta.toObject(row);
            const deviceId = String(obj.device_id || '');
            if (deviceId && obj.sequence !== undefined && obj.hash) {
              results.set(deviceId, {
                sequence: typeof obj.sequence === 'number' ? obj.sequence : parseInt(String(obj.sequence), 10),
                hash: String(obj.hash)
              });
            }
          },
          error(error) { reject(error); },
          complete() { resolve(results); }
        });
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to query latest device state entries', { error: errorMessage });
      return new Map();
    }
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
    event: string; timestamp: string; hashPreimage?: string;
  }>> {
    try {
      const start = startTime || '0';
      const fluxQuery = `
        from(bucket: "${this.resolveBucket(BucketTarget.COMPLIANCE)}")
          |> range(start: ${start})
          |> filter(fn: (r) => r._measurement == "pki_audit")
          |> filter(fn: (r) => r._field == "sequence" or r._field == "hash" or r._field == "previous_hash" or r._field == "hash_preimage")
          |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
          |> sort(columns: ["_time"])
      `;
      const results: Array<{
        sequence: number; hash: string; previousHash: string;
        event: string; timestamp: string; hashPreimage?: string;
      }> = [];
      return new Promise((resolve, reject) => {
        this.queryApi.queryRows(fluxQuery, {
          next(row, tableMeta) {
            const obj = tableMeta.toObject(row);
            const entry: {
              sequence: number; hash: string; previousHash: string;
              event: string; timestamp: string; hashPreimage?: string;
            } = {
              sequence: typeof obj.sequence === 'number' ? obj.sequence : parseInt(String(obj.sequence), 10),
              hash: String(obj.hash || ''),
              previousHash: String(obj.previous_hash || ''),
              event: String(obj.event || ''),
              timestamp: String(obj._time || '')
            };
            if (obj.hash_preimage) {
              entry.hashPreimage = String(obj.hash_preimage);
            }
            results.push(entry);
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

  // ── Health check ───────────────────────────────────────────────────

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

export function setInfluxService(svc: InfluxService): void {
  influxServiceInstance = svc;
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
