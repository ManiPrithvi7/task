import { Point, WriteApi } from '@influxdata/influxdb-client';
import { InfluxDiskQueue } from '../../services/influxDiskQueue';
import { InfluxDBConfig } from '../../config';
import { BucketTarget } from './types';
import { sanitizeInfluxLineProtocol } from '../../utils/influxTimestamp';

export abstract class BaseInfluxRepo<TInput> {
  constructor(
    protected readonly config: InfluxDBConfig,
    protected readonly writeApi: WriteApi,
    protected readonly diskQueue: InfluxDiskQueue | null,
  ) {}

  /** Never truncates compliance-bucket data. Metrics may be sliced to auditMaxFieldLength. */
  protected truncate(value: string, target: BucketTarget): string {
    if (target === BucketTarget.COMPLIANCE) return value;
    const max = this.config.auditMaxFieldLength;
    if (value.length <= max) return value;
    return value.slice(0, Math.max(0, max - 3)) + '...';
  }

  protected async submit(point: Point, target: BucketTarget, flushImmediately: boolean): Promise<void> {
    const queue = this.diskQueue;
    if (queue) {
      const raw = point.toLineProtocol();
      const line = raw ? sanitizeInfluxLineProtocol(raw) : null;
      if (!line) return;
      await queue.enqueue(line);
      return;
    }
    this.writeApi.writePoint(point);
    if (flushImmediately) await this.writeApi.flush();
  }

  abstract buildPoint(input: TInput): Point;
  abstract write(input: TInput): Promise<void>;
}
