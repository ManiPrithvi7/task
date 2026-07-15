import { Point, WriteApi } from '@influxdata/influxdb-client';
import { InfluxDiskQueue } from '../../services/influxDiskQueue';
import { InfluxDBConfig } from '../../config';
import { BucketTarget } from './types';
import { logger } from '../../utils/logger';

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
      const line = point.toLineProtocol();
      await queue.enqueue(line ?? '');
      return;
    }
    this.writeApi.writePoint(point);
    if (flushImmediately) await this.writeApi.flush();
  }

  abstract buildPoint(input: TInput): Point;
  abstract write(input: TInput): Promise<void>;
}
