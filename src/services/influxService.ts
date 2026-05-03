/**
 * InfluxDB Service for mqtt-publisher-lite
 * Time-series metrics storage for device, social media, and system metrics.
 *
 * Local: docker compose InfluxDB 2.x (e.g. 8086).
 * Hosted: set INFLUXDB_URL to the public HTTPS origin only — no port when TLS terminates at the proxy (e.g. Render → container :10000).
 * Config via env: INFLUXDB_URL, INFLUXDB_TOKEN, INFLUXDB_ORG, INFLUXDB_BUCKET
 */

import { InfluxDB, Point, WriteApi, QueryApi } from '@influxdata/influxdb-client';
import http from 'http';
import https from 'https';
import { logger } from '../utils/logger';
import { InfluxDBConfig } from '../config';
import { InfluxDiskQueue } from './influxDiskQueue';

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

/** One Influx row per Instagram Graph fetch attempt (replaces Mongo `instagram_fetch_audit` collection). */
export interface InstagramFetchAuditInfluxInput {
  deviceId: string;
  success: boolean;
  triggerType: string;
  correlationId?: string;
  instagramAccountId?: string;
  oldFollowers: number | null;
  newFollowers: number | null;
  durationMs: number;
  errorMessage?: string;
  errorCode?: string | number;
  mediaCount?: number;
  /** Defaults to now */
  timestamp?: Date;
}

export class InfluxService {
  private client: InfluxDB;
  private writeApi: WriteApi;
  private queryApi: QueryApi;
  private config: InfluxDBConfig;
  private diskQueue: InfluxDiskQueue | null = null;

  constructor(config: InfluxDBConfig) {
    this.config = config;

    this.client = new InfluxDB({
      url: this.config.url,
      token: this.config.token
    });

    this.writeApi = this.client.getWriteApi(this.config.org, this.config.bucket);
    this.queryApi = this.client.getQueryApi(this.config.org);

    this.writeApi.useDefaultTags({ service: 'mqtt-publisher-lite' });

    if (config.diskQueueEnabled) {
      this.diskQueue = new InfluxDiskQueue({
        queuePath: config.diskQueuePath,
        flushIntervalMs: config.diskQueueFlushMs,
        batchMax: config.diskQueueBatchMax,
        maxLinesPerFile: config.diskQueueMaxLinesPerFile
      });
      this.diskQueue.start(async (lines) => {
        if (lines.length === 0) return;
        this.writeApi.writeRecords(lines);
        await this.writeApi.flush();
      });
    }
  }

  /** Direct HTTP write vs disk WAL (HTTP batches on flush worker). */
  private async submitPoint(point: Point, flushImmediately: boolean): Promise<void> {
    if (this.diskQueue) {
      const line = point.toLineProtocol();
      await this.diskQueue.enqueue(line ?? '');
      return;
    }
    this.writeApi.writePoint(point);
    if (flushImmediately) await this.writeApi.flush();
  }

  /**
   * Write device metrics to InfluxDB
   */
  async writeDeviceMetrics(deviceId: string, metrics: DeviceMetrics): Promise<void> {
    try {
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

      if (metrics.timestamp) {
        point.timestamp(new Date(metrics.timestamp as string));
      } else {
        point.timestamp(new Date());
      }

      await this.submitPoint(point, true);

      logger.debug('Device metrics written to InfluxDB', { deviceId });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to write device metrics', { deviceId, error: errorMessage });
      throw error;
    }
  }

  /**
   * Write social media metrics (Instagram, GMB, etc.)
   */
  async writeSocialMetrics(platform: string, userId: string, metrics: SocialMetrics): Promise<void> {
    try {
      const point = new Point('social_metrics')
        .tag('platform', platform)
        .tag('user_id', userId)
        .tag('source', 'mqtt-publisher-lite');

      if (typeof metrics.followers === 'number') point.intField('followers', metrics.followers);
      if (typeof metrics.following === 'number') point.intField('following', metrics.following);
      if (typeof metrics.posts === 'number') point.intField('posts', metrics.posts);
      if (typeof metrics.likes === 'number') point.intField('likes', metrics.likes);
      if (typeof metrics.comments === 'number') point.intField('comments', metrics.comments);
      if (typeof metrics.shares === 'number') point.intField('shares', metrics.shares);
      if (typeof metrics.engagement_rate === 'number') point.floatField('engagement_rate', metrics.engagement_rate);

      if (metrics.post_id) point.stringField('post_id', metrics.post_id);
      if (metrics.content_type) point.stringField('content_type', metrics.content_type);

      point.timestamp(new Date());

      await this.submitPoint(point, true);

      logger.debug('Social metrics written to InfluxDB', { platform, userId });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to write social metrics', { platform, userId, error: errorMessage });
      throw error;
    }
  }

  /**
   * Write system-level metrics (CPU, memory, MQTT stats)
   */
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

      await this.submitPoint(point, true);

      logger.debug('System metrics written to InfluxDB');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to write system metrics', { error: errorMessage });
      throw error;
    }
  }

  /**
   * Append-only audit trail for Instagram fetch attempts (`instagram_fetch_audit` measurement).
   * Tags: device_id, success, trigger_type; optional correlation_id, instagram_account_id, error_code.
   * Fields: duration_ms; optional old_followers, new_followers, media_count, error_message.
   */
  async writeInstagramFetchAudit(
    input: InstagramFetchAuditInfluxInput,
    opts?: { flush?: boolean }
  ): Promise<void> {
    try {
      const point = new Point('instagram_fetch_audit')
        .tag('device_id', input.deviceId)
        .tag('success', input.success ? 'true' : 'false')
        .tag('trigger_type', input.triggerType);

      if (input.correlationId) point.tag('correlation_id', input.correlationId);
      if (input.instagramAccountId) point.tag('instagram_account_id', input.instagramAccountId);
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
      if (typeof input.mediaCount === 'number' && Number.isFinite(input.mediaCount)) {
        point.intField('media_count', Math.round(input.mediaCount));
      }
      if (!input.success && input.errorMessage) {
        point.stringField('error_message', input.errorMessage.slice(0, 4096));
      }

      point.timestamp(input.timestamp ?? new Date());

      await this.submitPoint(point, opts?.flush !== false);

      logger.debug('Instagram fetch audit written to InfluxDB', { deviceId: input.deviceId, success: input.success });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to write instagram_fetch_audit', { deviceId: input.deviceId, error: errorMessage });
      throw error;
    }
  }

  /** Snapshot follower count (`instagram_metrics`). */
  async writeInstagramFollowersGauge(
    deviceId: string,
    instagramAccountId: string,
    followers: number,
    timestamp?: Date,
    opts?: { flush?: boolean }
  ): Promise<void> {
    const point = new Point('instagram_metrics')
      .tag('device_id', deviceId)
      .tag('instagram_account_id', instagramAccountId || 'unknown')
      .intField('followers', Math.round(followers))
      .timestamp(timestamp ?? new Date());
    await this.submitPoint(point, opts?.flush !== false);
  }

  async writeInstagramAttentionE2eLatency(
    deviceId: string,
    triggerType: string,
    latencyMs: number,
    timestamp?: Date,
    opts?: { flush?: boolean }
  ): Promise<void> {
    const point = new Point('instagram_attention_e2e')
      .tag('device_id', deviceId)
      .tag('trigger', triggerType)
      .intField('latency_ms', Math.round(latencyMs))
      .timestamp(timestamp ?? new Date());
    await this.submitPoint(point, opts?.flush !== false);
  }

  /** Flush buffered writes (use after multiple writes with `{ flush: false }`). */
  async flushWrites(): Promise<void> {
    if (this.diskQueue) {
      await this.diskQueue.flushNow();
      return;
    }
    await this.writeApi.flush();
  }

  /**
   * Query device metrics for a time range
   */
  async queryDeviceMetrics(deviceId: string, startTime: string, endTime?: string): Promise<Record<string, unknown>[]> {
    try {
      const end = endTime || new Date().toISOString();

      const query = `
        from(bucket: "${this.config.bucket}")
          |> range(start: ${startTime}, stop: ${end})
          |> filter(fn: (r) => r._measurement == "device_metrics")
          |> filter(fn: (r) => r.device_id == "${deviceId}")
          |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
      `;

      const results: Record<string, unknown>[] = [];

      return new Promise((resolve, reject) => {
        this.queryApi.queryRows(query, {
          next(row, tableMeta) {
            results.push(tableMeta.toObject(row));
          },
          error(error) {
            logger.error('InfluxDB query error', { error: error.message });
            reject(error);
          },
          complete() {
            logger.debug('Device metrics query completed', { deviceId, count: results.length });
            resolve(results);
          }
        });
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to query device metrics', { deviceId, error: errorMessage });
      throw error;
    }
  }

  /**
   * Query social media metrics for a time range
   */
  async querySocialMetrics(platform: string, userId: string, startTime: string, endTime?: string): Promise<Record<string, unknown>[]> {
    try {
      const end = endTime || new Date().toISOString();

      const query = `
        from(bucket: "${this.config.bucket}")
          |> range(start: ${startTime}, stop: ${end})
          |> filter(fn: (r) => r._measurement == "social_metrics")
          |> filter(fn: (r) => r.platform == "${platform}")
          |> filter(fn: (r) => r.user_id == "${userId}")
          |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
      `;

      const results: Record<string, unknown>[] = [];

      return new Promise((resolve, reject) => {
        this.queryApi.queryRows(query, {
          next(row, tableMeta) {
            results.push(tableMeta.toObject(row));
          },
          error(error) {
            logger.error('InfluxDB query error', { error: error.message });
            reject(error);
          },
          complete() {
            logger.debug('Social metrics query completed', { platform, userId, count: results.length });
            resolve(results);
          }
        });
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to query social metrics', { platform, userId, error: errorMessage });
      throw error;
    }
  }

  /**
   * Get latest metrics for a device (last 1h)
   */
  async getLatestDeviceMetrics(deviceId: string): Promise<Record<string, unknown> | null> {
    try {
      const query = `
        from(bucket: "${this.config.bucket}")
          |> range(start: -1h)
          |> filter(fn: (r) => r._measurement == "device_metrics")
          |> filter(fn: (r) => r.device_id == "${deviceId}")
          |> last()
          |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
      `;

      const results: Record<string, unknown>[] = [];

      return new Promise((resolve, reject) => {
        this.queryApi.queryRows(query, {
          next(row, tableMeta) {
            results.push(tableMeta.toObject(row));
          },
          error(error) {
            logger.error('InfluxDB query error', { error: error.message });
            reject(error);
          },
          complete() {
            resolve(results.length > 0 ? results[0] : null);
          }
        });
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to get latest device metrics', { deviceId, error: errorMessage });
      throw error;
    }
  }

  /**
   * Write PKI audit event to InfluxDB as time-series data.
   * Enables dashboarding, alerting, and trend analysis on certificate lifecycle events.
   * 
   * Measurement: pki_audit
   * Tags: event, deviceId, orderId, batchId (high-cardinality filters)
   * Fields: details, hash, sequence (low-cardinality values)
   */
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
    try {
      const point = new Point('pki_audit')
        .tag('event', data.event)
        .tag('source', 'mqtt-publisher-lite');

      if (data.deviceId) point.tag('device_id', data.deviceId);
      if (data.orderId) point.tag('order_id', data.orderId);
      if (data.batchId) point.tag('batch_id', data.batchId);
      if (data.userId) point.stringField('user_id', data.userId);
      if (data.serialNumber) point.stringField('serial_number', data.serialNumber);
      if (data.certificateFingerprint) point.stringField('cert_fingerprint', data.certificateFingerprint);
      if (typeof data.sequence === 'number') point.intField('sequence', data.sequence);
      if (data.hash) point.stringField('hash', data.hash);
      if (data.previousHash) point.stringField('previous_hash', data.previousHash);
      if (data.details) point.stringField('details', JSON.stringify(data.details));

      point.intField('count', 1);
      point.timestamp(new Date());

      await this.submitPoint(point, true);

      logger.debug('PKI audit event written to InfluxDB', { event: data.event, deviceId: data.deviceId });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('Failed to write PKI audit to InfluxDB', { event: data.event, error: errorMessage });
    }
  }

  /**
   * Write rate limit event to InfluxDB for monitoring dashboards.
   * 
   * Measurement: rate_limit_events
   * Tags: limit_type, endpoint, ip
   * Fields: count, limit, remaining
   */
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
        .tag('ip', data.ip)
        .tag('source', 'mqtt-publisher-lite')
        .intField('count', data.count)
        .intField('limit', data.limit)
        .intField('remaining', Math.max(0, data.limit - data.count))
        .intField('exceeded', 1);

      if (data.deviceId) point.tag('device_id', data.deviceId);
      point.timestamp(new Date());

      await this.submitPoint(point, true);

      logger.debug('Rate limit event written to InfluxDB', { limitType: data.limitType, endpoint: data.endpoint });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('Failed to write rate limit event to InfluxDB', { error: errorMessage });
    }
  }

  /**
   * Query PKI audit events for a time range (for monitoring/alerting)
   */
  async queryAuditEvents(startTime: string, endTime?: string, eventType?: string): Promise<Record<string, unknown>[]> {
    try {
      const end = endTime || new Date().toISOString();
      let fluxQuery = `
        from(bucket: "${this.config.bucket}")
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

  /**
   * Write a certificate transparency log entry to InfluxDB.
   * 
   * Measurement: ct_log
   * Tags: device_id, cn
   * Fields: index, leaf_hash, root_hash, inclusion_proof, serial_number, cert_fingerprint
   */
  async writeTransparencyEntry(data: {
    index: number;
    leafHash: string;
    rootHash: string;
    inclusionProof: string;  // JSON-stringified
    certFingerprint: string;
    serialNumber: string;
    cn: string;
    deviceId: string;
    issuedAt: Date;
  }): Promise<void> {
    try {
      const point = new Point('ct_log')
        .tag('device_id', data.deviceId)
        .tag('cn', data.cn)
        .tag('source', 'mqtt-publisher-lite')
        .intField('index', data.index)
        .stringField('leaf_hash', data.leafHash)
        .stringField('root_hash', data.rootHash)
        .stringField('inclusion_proof', data.inclusionProof)
        .stringField('cert_fingerprint', data.certFingerprint)
        .stringField('serial_number', data.serialNumber)
        .timestamp(data.issuedAt);

      await this.submitPoint(point, true);

      logger.debug('CT log entry written to InfluxDB', { index: data.index, deviceId: data.deviceId });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('Failed to write CT log entry to InfluxDB', { index: data.index, error: errorMessage });
    }
  }

  /**
   * Query all transparency log leaf hashes (ordered by index) for tree rebuild.
   * Used during TransparencyLog initialization.
   */
  async queryTransparencyLeaves(): Promise<Array<{ index: number; leafHash: string }>> {
    try {
      const fluxQuery = `
        from(bucket: "${this.config.bucket}")
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

  /**
   * Query the latest audit entry (highest sequence) for chain resumption.
   * Used during AuditService initialization.
   */
  async queryLatestAuditEntry(): Promise<{ sequence: number; hash: string } | null> {
    try {
      const fluxQuery = `
        from(bucket: "${this.config.bucket}")
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

  /**
   * Query all audit entries ordered by time for chain verification.
   * Returns entries in ascending time order with sequence, hash, previousHash.
   */
  async queryAuditChain(startTime?: string): Promise<Array<{
    sequence: number; hash: string; previousHash: string;
    event: string; timestamp: string;
  }>> {
    try {
      const start = startTime || '0';
      const fluxQuery = `
        from(bucket: "${this.config.bucket}")
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

  /**
   * Health check — HTTP `/health` then authenticated REST `GET /api/v2/buckets` (validates token + org + bucket).
   * InfluxDB 2 has no long-lived “persistent connection”: writes/queries are HTTP; the JS client batches over HTTP.
   * We avoid Flux/queryRows for startup readiness — behind some proxies (e.g. Render) `/api/v2/query` can stall
   * while `/health` and `/api/v2/buckets` respond normally.
   *
   * Hosted services may be idle: `/health` and buckets calls retry (default 3) with delay between attempts.
   * Configure: INFLUXDB_HEALTH_RETRIES, INFLUXDB_HEALTH_RETRY_DELAY_MS, INFLUXDB_HEALTH_TIMEOUT_MS.
   */
  async healthCheck(): Promise<boolean> {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    const rawBase = this.config.url.replace(/\/+$/, '');
    const u = new URL(`${rawBase}/health`);
    if (u.hostname === 'localhost') u.hostname = '127.0.0.1';

    const isLoopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost';

    const retriesEnv = parseInt(process.env.INFLUXDB_HEALTH_RETRIES?.trim() || '', 10);
    const maxAttempts =
      Number.isFinite(retriesEnv) && retriesEnv >= 1
        ? Math.min(retriesEnv, 10)
        : isLoopback
          ? 1
          : 3;

    const delayEnv = parseInt(process.env.INFLUXDB_HEALTH_RETRY_DELAY_MS?.trim() || '', 10);
    const retryDelayMs = Number.isFinite(delayEnv) && delayEnv >= 0 ? delayEnv : 2500;

    const healthTimeoutEnv = parseInt(process.env.INFLUXDB_HEALTH_TIMEOUT_MS?.trim() || '', 10);
    const healthTimeoutMs =
      Number.isFinite(healthTimeoutEnv) && healthTimeoutEnv > 0
        ? healthTimeoutEnv
        : isLoopback
          ? 3000
          : 20000;

    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;

    const oneHealthGet = (): Promise<{ statusCode: number; json: any }> =>
      new Promise((resolve, reject) => {
        const req = mod.request(
          {
            method: 'GET',
            hostname: u.hostname,
            port: u.port ? Number(u.port) : isHttps ? 443 : 80,
            path: `${u.pathname}${u.search}`,
            timeout: healthTimeoutMs
          },
          (res) => {
            let raw = '';
            res.on('data', (c) => (raw += c));
            res.on('end', () => {
              let json: any = {};
              try {
                json = raw ? JSON.parse(raw) : {};
              } catch {
                json = {};
              }
              resolve({ statusCode: res.statusCode ?? 0, json });
            });
          }
        );
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end();
      });

    let healthOk = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const body = await oneHealthGet();
        const payload = body.json as { status?: string; message?: string };
        if (body.statusCode >= 200 && body.statusCode < 300 && (!payload.status || payload.status === 'pass')) {
          healthOk = true;
          if (attempt > 1) {
            logger.info('📈 InfluxDB /health OK after retry', { attempt, maxAttempts });
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
          attempt,
          maxAttempts,
          url: this.config.url,
          error: msg
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

    const bucket = this.config.bucket;
    const org = this.config.org;
    const apiProbeEnv = parseInt(process.env.INFLUXDB_API_PROBE_TIMEOUT_MS?.trim() || '', 10);
    const fluxFallbackEnv = parseInt(process.env.INFLUXDB_FLUX_PROBE_TIMEOUT_MS?.trim() || '', 10);
    const apiTimeoutMs =
      Number.isFinite(apiProbeEnv) && apiProbeEnv > 0
        ? apiProbeEnv
        : Number.isFinite(fluxFallbackEnv) && fluxFallbackEnv > 0
          ? fluxFallbackEnv
          : isLoopback
            ? 8000
            : 20000;

    logger.info('📈 InfluxDB /health OK; verifying API token (GET /api/v2/buckets)', {
      apiTimeoutMs,
      org,
      bucket,
      maxAttempts
    });

    const bucketsUrl = new URL(`${rawBase}/api/v2/buckets`);
    bucketsUrl.searchParams.set('org', org);
    if (bucketsUrl.hostname === 'localhost') bucketsUrl.hostname = '127.0.0.1';

    const isHttpsBuckets = bucketsUrl.protocol === 'https:';
    const modBuckets = isHttpsBuckets ? https : http;
    const token = this.config.token?.trim() ?? '';

    const oneBucketsGet = (): Promise<{ statusCode: number; json: any }> =>
      new Promise((resolve, reject) => {
        const req = modBuckets.request(
          {
            method: 'GET',
            hostname: bucketsUrl.hostname,
            port: bucketsUrl.port ? Number(bucketsUrl.port) : isHttpsBuckets ? 443 : 80,
            path: `${bucketsUrl.pathname}${bucketsUrl.search}`,
            timeout: apiTimeoutMs,
            headers: {
              Authorization: `Token ${token}`,
              Accept: 'application/json'
            }
          },
          (incoming) => {
            let raw = '';
            incoming.on('data', (c) => (raw += c));
            incoming.on('end', () => {
              let json: any = {};
              try {
                json = raw ? JSON.parse(raw) : {};
              } catch {
                json = {};
              }
              resolve({ statusCode: incoming.statusCode ?? 0, json });
            });
          }
        );
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end();
      });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await oneBucketsGet();

        if (res.statusCode === 401 || res.statusCode === 403) {
          logger.warn('InfluxDB buckets API rejected token', { status: res.statusCode, org });
          return false;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          const retryable = res.statusCode >= 500 || res.statusCode === 429;
          if (retryable && attempt < maxAttempts) {
            logger.warn('InfluxDB buckets API transient error; retrying', {
              status: res.statusCode,
              attempt,
              maxAttempts
            });
            await sleep(retryDelayMs);
            continue;
          }
          logger.warn('InfluxDB buckets API HTTP error', {
            status: res.statusCode,
            org,
            message: res.json?.message || res.json?.code
          });
          return false;
        }

        const buckets = Array.isArray(res.json?.buckets) ? res.json.buckets : [];
        const hasBucket = buckets.some((b: { name?: string }) => b?.name === bucket);
        if (!hasBucket) {
          logger.warn('InfluxDB: configured bucket not found for org (check INFLUXDB_BUCKET)', {
            org,
            bucket,
            bucketNames: buckets.map((b: { name?: string }) => b?.name).filter(Boolean)
          });
          return false;
        }

        if (attempt > 1) {
          logger.info('📈 InfluxDB buckets API OK after retry', { attempt, maxAttempts });
        }
        return true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('InfluxDB buckets API attempt failed', {
          attempt,
          maxAttempts,
          error: msg
        });
        if (attempt === maxAttempts) {
          logger.warn('InfluxDB buckets API unreachable after retries', {
            url: this.config.url,
            org,
            bucket,
            error: msg
          });
          return false;
        }
        await sleep(retryDelayMs);
      }
    }

    return false;
  }

  /**
   * Flush pending writes and close the connection
   */
  async close(): Promise<void> {
    try {
      if (this.diskQueue) {
        await this.diskQueue.shutdown(async (lines) => {
          if (lines.length === 0) return;
          this.writeApi.writeRecords(lines);
          await this.writeApi.flush();
        });
        this.diskQueue = null;
      }
      await this.writeApi.close();
      logger.info('InfluxDB connection closed');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error closing InfluxDB connection', { error: errorMessage });
    }
  }
}

/** Singleton instance */
let influxServiceInstance: InfluxService | null = null;

/**
 * Create and return singleton InfluxService.
 * Call once during app startup; subsequent calls return the same instance.
 */
export function createInfluxService(config: InfluxDBConfig): InfluxService {
  influxServiceInstance = new InfluxService(config);
  return influxServiceInstance;
}

/**
 * Get the current InfluxService instance (null if not initialized or disabled).
 */
export function getInfluxService(): InfluxService | null {
  return influxServiceInstance;
}

/** Clear singleton after failed startup or shutdown (avoids stale writes). */
export async function resetInfluxService(): Promise<void> {
  if (!influxServiceInstance) return;
  try {
    await influxServiceInstance.close();
  } catch {
    /* ignore */
  }
  influxServiceInstance = null;
}
