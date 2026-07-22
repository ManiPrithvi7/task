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

  protected truncate(value: string): string {
    return value.slice(0, this.config.auditMaxFieldLength);
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
