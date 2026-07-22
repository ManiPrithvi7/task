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

describe('InfluxDiskQueue poison-pill handling', () => {
  let queuePath: string;

  beforeEach(async () => {
    queuePath = path.join(os.tmpdir(), `influx-queue-poison-${Date.now()}.lines`);
  });

  afterEach(async () => {
    await fs.unlink(queuePath).catch(() => {});
    await fs.unlink(`${queuePath}.draining`).catch(() => {});
    await fs.unlink(`${queuePath}.rejected`).catch(() => {});
  });

  it('dead-letters permanent bad line and sends good lines', async () => {
    const q = new InfluxDiskQueue({
      queuePath,
      flushIntervalMs: 60_000,
      batchMax: 10,
      maxLinesPerFile: 1000,
      syncOnAppend: false
    });

    const sent: string[][] = [];
    const err400 = Object.assign(new Error('unable to parse line: value out of range'), { statusCode: 400 });

    q.start(async (lines) => {
      sent.push(lines);
      if (lines.length > 1 || lines[0].includes('bad_ts')) {
        throw err400;
      }
    });

    await q.enqueue('good1 a=1i 1700000000000000000');
    await q.enqueue('good2 a=2i 1700000000000000001');
    await q.enqueue('bad_ts a=3i 593807155200000000000');
    await q.waitAppends();
    await q.flushNow();
    await new Promise((r) => setTimeout(r, 50));

    expect(sent.some((batch) => batch.includes('good1 a=1i 1700000000000000000'))).toBe(true);
    expect(sent.some((batch) => batch.includes('good2 a=2i 1700000000000000001'))).toBe(true);

    const rejected = await fs.readFile(`${queuePath}.rejected`, 'utf8');
    expect(rejected).toContain('bad_ts');
  });
});
