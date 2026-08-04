import * as path from 'path';
import { envInt, envString } from './envHelpers';

export interface InfluxDBConfig {
  /** Directory for influx_usage.csv (default: DATA_DIR or ./data) */
  dataDir: string;
  url: string;
  token: string;
  org: string;
  bucket: string;
  complianceBucket: string;
  diskQueueEnabled: boolean;
  diskQueueSyncOnAppend: boolean;
  diskQueuePath: string;
  diskQueueFlushMs: number;
  diskQueueBatchMax: number;
  diskQueueMaxLinesPerFile: number;
  clientBatchSize: number;
  clientFlushIntervalMs: number;
  auditMaxFieldLength: number;
  logWrites: boolean;
}

/** Normalize Influx URL — host-only values get http:// prefix. */
export function normalizeInfluxDbUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return trimmed;
}

export function loadInfluxDbConfig(dataDir: string): InfluxDBConfig {
  const influxToken = process.env.INFLUXDB_TOKEN?.trim() || '';
  const influxUrlRaw =
    process.env.INFLUXDB_URL?.trim() ||
    process.env.INFLUXDB_HOST?.trim() ||
    'http://localhost:8086';
  const influxUrl = normalizeInfluxDbUrl(influxUrlRaw);
  const influxDiskQueueDisabled =
    process.env.INFLUXDB_DISK_QUEUE === 'false' || process.env.INFLUXDB_DISK_QUEUE === '0';
  const influxDiskQueueEnabled = !influxDiskQueueDisabled;
  const influxDiskQueueSyncOnAppend =
    process.env.INFLUXDB_DISK_QUEUE_SYNC === 'true' || process.env.INFLUXDB_DISK_QUEUE_SYNC === '1';
  const influxQueuePathRaw = process.env.INFLUXDB_DISK_QUEUE_PATH?.trim();
  const influxQueuePath = influxQueuePathRaw
    ? path.isAbsolute(influxQueuePathRaw)
      ? influxQueuePathRaw
      : path.resolve(process.cwd(), influxQueuePathRaw)
    : path.join(path.resolve(dataDir), 'influx-write-queue.lines');
  const influxQueueFlushMs = Math.max(
    1000,
    envInt('INFLUXDB_QUEUE_FLUSH_MS', 1000, ['BATCH_TIMEOUT'])
  );
  const influxQueueBatchMax = Math.max(
    1,
    parseInt(process.env.INFLUXDB_QUEUE_BATCH_MAX || '500', 10) || 500
  );
  const influxQueueMaxLinesRaw = parseInt(process.env.INFLUXDB_QUEUE_MAX_LINES_PER_FILE || '100000', 10);
  const influxQueueMaxLinesPerFile =
    Number.isFinite(influxQueueMaxLinesRaw) && influxQueueMaxLinesRaw > 0 ? influxQueueMaxLinesRaw : 100_000;
  const influxClientBatchSize = Math.max(
    1,
    parseInt(process.env.INFLUXDB_CLIENT_BATCH_SIZE || '500', 10) || 500
  );
  const influxClientFlushIntervalMs = Math.max(
    100,
    parseInt(process.env.INFLUXDB_CLIENT_FLUSH_INTERVAL_MS || '1000', 10) || 1000
  );
  const influxAuditMaxFieldRaw = parseInt(process.env.INFLUX_AUDIT_MAX_FIELD_LENGTH || '4096', 10);
  const influxAuditMaxFieldLength =
    Number.isFinite(influxAuditMaxFieldRaw) && influxAuditMaxFieldRaw > 0 ? influxAuditMaxFieldRaw : 4096;

  return {
    dataDir: path.resolve(dataDir),
    url: influxUrl,
    token: influxToken,
    org: process.env.INFLUXDB_ORG?.trim() || 'statsmqtt',
    bucket: process.env.INFLUXDB_BUCKET?.trim() || 'metrics',
    complianceBucket: process.env.INFLUXDB_COMPLIANCE_BUCKET?.trim() || 'pki_compliance',
    diskQueueEnabled: influxDiskQueueEnabled,
    diskQueueSyncOnAppend: influxDiskQueueSyncOnAppend,
    diskQueuePath: influxQueuePath,
    diskQueueFlushMs: influxQueueFlushMs,
    diskQueueBatchMax: influxQueueBatchMax,
    diskQueueMaxLinesPerFile: influxQueueMaxLinesPerFile,
    clientBatchSize: influxClientBatchSize,
    clientFlushIntervalMs: influxClientFlushIntervalMs,
    auditMaxFieldLength: influxAuditMaxFieldLength,
    logWrites: envString('NODE_ENV', 'development') === 'development'
  };
}
