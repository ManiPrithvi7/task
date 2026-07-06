import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { InfluxDiskQueue } from '@/services/influxDiskQueue';

describe('InfluxDiskQueue syncOnAppend', () => {
  let queuePath: string;

  beforeEach(async () => {
    queuePath = path.join(os.tmpdir(), `influx-queue-test-${Date.now()}.lines`);
  });

  afterEach(async () => {
    await fs.unlink(queuePath).catch(() => {});
    await fs.unlink(`${queuePath}.draining`).catch(() => {});
  });

  it('appends line protocol to disk', async () => {
    const q = new InfluxDiskQueue({
      queuePath,
      flushIntervalMs: 60_000,
      batchMax: 10,
      maxLinesPerFile: 1000,
      syncOnAppend: false
    });
    await q.enqueue('m,device_id=a v=1');
    await q.waitAppends();
    const raw = await fs.readFile(queuePath, 'utf8');
    expect(raw).toContain('m,device_id=a v=1');
  });

  it('fsyncs when syncOnAppend is enabled', async () => {
    const openSpy = jest.spyOn(fs, 'open');
    const q = new InfluxDiskQueue({
      queuePath,
      flushIntervalMs: 60_000,
      batchMax: 10,
      maxLinesPerFile: 1000,
      syncOnAppend: true
    });
    await q.enqueue('m,device_id=b v=2');
    await q.waitAppends();
    expect(openSpy).toHaveBeenCalled();
    openSpy.mockRestore();
  });
});
