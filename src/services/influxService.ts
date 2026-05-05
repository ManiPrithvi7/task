/**
 * InfluxDB Service for mqtt-publisher-lite
 * Time-series metrics storage for device states, social media milestones (Instagram/GMB),
 * compliance audit data, and PKI certificate lifecycle events.
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

export interface DeviceStateMetrics {
  device_id: string;
  status: 'online' | 'offline' | 'active' | 'inactive';
  last_seen: Date;
  battery_level?: number;
  signal_strength?: number;
  firmware_version?: string;
}

export interface InstagramMilestoneMetrics {
  device_id: string;
  instagram_account_id: string;
  followers_count: number;
  following_count?: number;
  posts_count?: number;
  milestone_reached?: {
    type: 'followers' | 'posts' | 'engagement';
    threshold: number;
    achieved_at: Date;
  };
  fetch_timestamp: Date;
  success: boolean;
  error_message?: string;
}

export interface GMBMilestoneMetrics {
  device_id: string;
  location_id: string;
  reviews_count: number;
  average_rating?: number;
  milestone_reached?: {
    type: 'reviews' | 'rating';
    threshold: number;
    achieved_at: Date;
  };
  fetch_timestamp: Date;
  success: boolean;
  error_message?: string;
}

export interface ComplianceAuditData {
  device_id: string;
  audit_type: 'certificate_renewal' | 'config_change' | 'firmware_update' | 'security_event';
  status: 'success' | 'failure' | 'pending';
  timestamp: Date;
  details: Record<string, unknown>;
  hash?: string;
  previous_hash?: string;
}

/** PKI Certificate Transparency Log Entry */
export interface TransparencyLogEntry {
  index: number;
  leafHash: string;
  rootHash: string;
  inclusionProof: string; // JSON-stringified
  certFingerprint: string;
  serialNumber: string;
  cn: string;
  deviceId: string;
  issuedAt: Date;
}

/** PKI Audit Event (for certificate chain) */
export interface PKIAuditEvent {
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

  private async submitPoint(point: Point, flushImmediately: boolean): Promise<void> {
    if (this.diskQueue) {
      const line = point.toLineProtocol();
      await this.diskQueue.enqueue(line ?? '');
      return;
    }
    this.writeApi.writePoint(point);
    if (flushImmediately) await this.writeApi.flush();
  }

  // ==================== DEVICE STATE METRICS ====================

  async writeDeviceState(metrics: DeviceStateMetrics): Promise<void> {
    try {
      const point = new Point('device_state')
        .tag('device_id', metrics.device_id)
        .tag('status', metrics.status)
        .tag('source', 'mqtt-publisher-lite')
        .timestamp(metrics.last_seen);

      if (metrics.battery_level !== undefined) {
        point.floatField('battery_level', metrics.battery_level);
      }
      if (metrics.signal_strength !== undefined) {
        point.intField('signal_strength', metrics.signal_strength);
      }
      if (metrics.firmware_version) {
        point.stringField('firmware_version', metrics.firmware_version);
      }

      point.intField('state_change', 1);

      await this.submitPoint(point, true);
      logger.debug('Device state written to InfluxDB', { deviceId: metrics.device_id, status: metrics.status });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to write device state', { deviceId: metrics.device_id, error: errorMessage });
      throw error;
    }
  }

  // ==================== INSTAGRAM METRICS ====================

  async writeInstagramMetrics(metrics: InstagramMilestoneMetrics): Promise<void> {
    try {
      const point = new Point('instagram_metrics')
        .tag('device_id', metrics.device_id)
        .tag('instagram_account_id', metrics.instagram_account_id)
        .tag('success', metrics.success ? 'true' : 'false')
        .tag('source', 'mqtt-publisher-lite')
        .timestamp(metrics.fetch_timestamp);

      point.intField('followers_count', metrics.followers_count);

      if (metrics.following_count !== undefined) {
        point.intField('following_count', metrics.following_count);
      }
      if (metrics.posts_count !== undefined) {
        point.intField('posts_count', metrics.posts_count);
      }

      if (metrics.milestone_reached) {
        point.stringField('milestone_type', metrics.milestone_reached.type);
        point.intField('milestone_threshold', metrics.milestone_reached.threshold);
        point.intField('milestone_achieved', 1);
      } else {
        point.intField('milestone_achieved', 0);
      }

      point.intField('fetch_attempt', 1);

      if (!metrics.success && metrics.error_message) {
        point.stringField('error_message', metrics.error_message.slice(0, 1024));
      }

      await this.submitPoint(point, true);
      logger.debug('Instagram metrics written to InfluxDB', {
        deviceId: metrics.device_id,
        accountId: metrics.instagram_account_id,
        followers: metrics.followers_count
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to write Instagram metrics', { deviceId: metrics.device_id, error: errorMessage });
      throw error;
    }
  }

  // ==================== GMB METRICS ====================

  async writeGMBMetrics(metrics: GMBMilestoneMetrics): Promise<void> {
    try {
      const point = new Point('gmb_metrics')
        .tag('device_id', metrics.device_id)
        .tag('location_id', metrics.location_id)
        .tag('success', metrics.success ? 'true' : 'false')
        .tag('source', 'mqtt-publisher-lite')
        .timestamp(metrics.fetch_timestamp);

      point.intField('reviews_count', metrics.reviews_count);

      if (metrics.average_rating !== undefined) {
        point.floatField('average_rating', metrics.average_rating);
      }

      if (metrics.milestone_reached) {
        point.stringField('milestone_type', metrics.milestone_reached.type);
        point.intField('milestone_threshold', metrics.milestone_reached.threshold);
        point.intField('milestone_achieved', 1);
      } else {
        point.intField('milestone_achieved', 0);
      }

      point.intField('fetch_attempt', 1);

      if (!metrics.success && metrics.error_message) {
        point.stringField('error_message', metrics.error_message.slice(0, 1024));
      }

      await this.submitPoint(point, true);
      logger.debug('GMB metrics written to InfluxDB', {
        deviceId: metrics.device_id,
        locationId: metrics.location_id,
        reviews: metrics.reviews_count
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to write GMB metrics', { deviceId: metrics.device_id, error: errorMessage });
      throw error;
    }
  }

  // ==================== COMPLIANCE AUDIT ====================

  async writeComplianceAudit(audit: ComplianceAuditData): Promise<void> {
    try {
      const point = new Point('compliance_audit')
        .tag('device_id', audit.device_id)
        .tag('audit_type', audit.audit_type)
        .tag('status', audit.status)
        .tag('source', 'mqtt-publisher-lite')
        .timestamp(audit.timestamp);

      point.stringField('details', JSON.stringify(audit.details));
      point.intField('audit_event', 1);

      if (audit.hash) {
        point.stringField('hash', audit.hash);
      }
      if (audit.previous_hash) {
        point.stringField('previous_hash', audit.previous_hash);
      }

      await this.submitPoint(point, true);
      logger.debug('Compliance audit written to InfluxDB', {
        deviceId: audit.device_id,
        auditType: audit.audit_type,
        status: audit.status
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to write compliance audit', { deviceId: audit.device_id, error: errorMessage });
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
  async writePKIAuditEvent(data: PKIAuditEvent): Promise<void> {
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
   * Query PKI audit events for a time range (for monitoring/alerting)
   */
  async queryPKIAuditEvents(startTime: string, endTime?: string, eventType?: string): Promise<Record<string, unknown>[]> {
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
  async writeTransparencyEntry(entry: TransparencyLogEntry): Promise<void> {
    try {
      const point = new Point('ct_log')
        .tag('device_id', entry.deviceId)
        .tag('cn', entry.cn)
        .tag('source', 'mqtt-publisher-lite')
        .intField('index', entry.index)
        .stringField('leaf_hash', entry.leafHash)
        .stringField('root_hash', entry.rootHash)
        .stringField('inclusion_proof', entry.inclusionProof)
        .stringField('cert_fingerprint', entry.certFingerprint)
        .stringField('serial_number', entry.serialNumber)
        .timestamp(entry.issuedAt);

      await this.submitPoint(point, true);

      logger.debug('CT log entry written to InfluxDB', { index: entry.index, deviceId: entry.deviceId });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('Failed to write CT log entry to InfluxDB', { index: entry.index, error: errorMessage });
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
  async queryLatestPKIAuditEntry(): Promise<{ sequence: number; hash: string } | null> {
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
  async queryPKIAuditChain(startTime?: string): Promise<Array<{
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

  // ==================== QUERY METHODS ====================

  async queryDeviceStateHistory(deviceId: string, startTime: string, endTime?: string): Promise<Record<string, unknown>[]> {
    try {
      const end = endTime || new Date().toISOString();
      const query = `
        from(bucket: "${this.config.bucket}")
          |> range(start: ${startTime}, stop: ${end})
          |> filter(fn: (r) => r._measurement == "device_state")
          |> filter(fn: (r) => r.device_id == "${deviceId}")
          |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
          |> sort(columns: ["_time"], desc: true)
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
      logger.error('Failed to query device state', { deviceId, error: errorMessage });
      throw error;
    }
  }

  async queryInstagramMilestones(deviceId: string, startTime: string, accountId?: string): Promise<Record<string, unknown>[]> {
    try {
      let query = `
        from(bucket: "${this.config.bucket}")
          |> range(start: ${startTime})
          |> filter(fn: (r) => r._measurement == "instagram_metrics")
          |> filter(fn: (r) => r.device_id == "${deviceId}")
          |> filter(fn: (r) => r.milestone_achieved == 1)
      `;

      if (accountId) {
        query += `  |> filter(fn: (r) => r.instagram_account_id == "${accountId}")\n`;
      }

      query += `  |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")`;
      query += `  |> sort(columns: ["_time"], desc: true)`;

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
      logger.error('Failed to query Instagram milestones', { deviceId, error: errorMessage });
      throw error;
    }
  }

  async queryGMBMilestones(deviceId: string, startTime: string, locationId?: string): Promise<Record<string, unknown>[]> {
    try {
      let query = `
        from(bucket: "${this.config.bucket}")
          |> range(start: ${startTime})
          |> filter(fn: (r) => r._measurement == "gmb_metrics")
          |> filter(fn: (r) => r.device_id == "${deviceId}")
          |> filter(fn: (r) => r.milestone_achieved == 1)
      `;

      if (locationId) {
        query += `  |> filter(fn: (r) => r.location_id == "${locationId}")\n`;
      }

      query += `  |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")`;
      query += `  |> sort(columns: ["_time"], desc: true)`;

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
      logger.error('Failed to query GMB milestones', { deviceId, error: errorMessage });
      throw error;
    }
  }

  async queryComplianceAudit(deviceId: string, startTime: string, auditType?: string): Promise<Record<string, unknown>[]> {
    try {
      let query = `
        from(bucket: "${this.config.bucket}")
          |> range(start: ${startTime})
          |> filter(fn: (r) => r._measurement == "compliance_audit")
          |> filter(fn: (r) => r.device_id == "${deviceId}")
      `;

      if (auditType) {
        query += `  |> filter(fn: (r) => r.audit_type == "${auditType}")\n`;
      }

      query += `  |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")`;
      query += `  |> sort(columns: ["_time"], desc: true)`;

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
      logger.error('Failed to query compliance audit', { deviceId, error: errorMessage });
      throw error;
    }
  }

  async getLatestDeviceState(deviceId: string): Promise<Record<string, unknown> | null> {
    try {
      const query = `
        from(bucket: "${this.config.bucket}")
          |> range(start: -24h)
          |> filter(fn: (r) => r._measurement == "device_state")
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
      logger.error('Failed to get latest device state', { deviceId, error: errorMessage });
      throw error;
    }
  }

  // ==================== UTILITY METHODS ====================

  async flushWrites(): Promise<void> {
    if (this.diskQueue) {
      await this.diskQueue.flushNow();
      return;
    }
    await this.writeApi.flush();
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
