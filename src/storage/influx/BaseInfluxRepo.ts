import { Point, WriteApi } from '@influxdata/influxdb-client';
import { InfluxDiskQueue } from '../../services/influxDiskQueue';
import { InfluxDBConfig } from '../../config';
import { BucketTarget } from './types';
import { sanitizeInfluxLineProtocol } from '../../utils/influxTimestamp';

export type InfluxWriteUsageCallback = (entry: {
  bucket: BucketTarget;
  measurement: string;
  line: string;
}) => void;

export abstract class BaseInfluxRepo<TInput> {
  constructor(
    protected readonly config: InfluxDBConfig,
    protected readonly writeApi: WriteApi,
    protected readonly diskQueue: InfluxDiskQueue | null,
    protected readonly onWriteUsage?: InfluxWriteUsageCallback
  ) {}

  /** Never truncates compliance-bucket data. Metrics may be sliced to auditMaxFieldLength. */
  protected truncate(value: string, target: BucketTarget): string {
    if (target === BucketTarget.COMPLIANCE) return value;
    const max = this.config.auditMaxFieldLength;
    if (value.length <= max) return value;
    return value.slice(0, Math.max(0, max - 3)) + '...';
  }

  /**
   * Enqueue a point to the disk WAL or write directly when the queue is disabled.
   * @param flushImmediately Ignored when disk queue is enabled (always async enqueue).
   */
  protected async submit(point: Point, target: BucketTarget, flushImmediately: boolean): Promise<void> {
    const queue = this.diskQueue;
    if (queue) {
      const raw = point.toLineProtocol();
      const line = raw ? sanitizeInfluxLineProtocol(raw) : null;
      if (!line) return;
      this.onWriteUsage?.({
        bucket: target,
        measurement: line.split(/[,\s]/)[0] || 'unknown',
        line
      });
      await queue.enqueue(line);
      return;
    }
    this.writeApi.writePoint(point);
    if (flushImmediately) await this.writeApi.flush();
  }

  /** Batch enqueue — single fsync on compliance path when syncOnAppend is enabled. */
  async submitBatch(points: Point[], target: BucketTarget): Promise<void> {
    if (points.length === 0) return;
    const diskQueue = this.diskQueue;
    if (diskQueue) {
      const lines = points
        .map((p) => p.toLineProtocol())
        .filter((line): line is string => Boolean(line))
        .map((line) => sanitizeInfluxLineProtocol(line))
        .filter((line): line is string => line !== null);
      if (lines.length === 0) return;
      for (const line of lines) {
        this.onWriteUsage?.({
          bucket: target,
          measurement: line.split(/[,\s]/)[0] || 'unknown',
          line
        });
      }
      await diskQueue.enqueueBatch(lines);
      return;
    }
    for (const point of points) {
      this.writeApi.writePoint(point);
    }
  }

  abstract buildPoint(input: TInput): Point;
  abstract write(input: TInput): Promise<void>;
}
