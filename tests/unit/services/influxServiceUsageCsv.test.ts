import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InfluxDB } from '@influxdata/influxdb-client';
import { InfluxService } from '@/services/influxService';
import type { InfluxDBConfig } from '@/config';

describe('InfluxService usage CSV', () => {
  let dataDir: string;
  let service: InfluxService;
  let mockQueryRows: jest.Mock;

  beforeEach(async () => {
    dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'influx-usage-'));
    mockQueryRows = jest.fn((_fluxQuery: string, handlers: { complete: () => void }) => {
      handlers.complete();
    });

    (InfluxDB as jest.Mock).mockImplementation(() => ({
      getWriteApi: jest.fn().mockReturnValue({
        writePoint: jest.fn(),
        writeRecords: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
        useDefaultTags: jest.fn(),
      }),
      getQueryApi: jest.fn().mockReturnValue({ queryRows: mockQueryRows }),
    }));

    const config: InfluxDBConfig = {
      dataDir,
      url: 'http://localhost:8086',
      token: 'test-token',
      org: 'test-org',
      bucket: 'metrics',
      complianceBucket: 'pki_compliance',
      diskQueueEnabled: false,
      diskQueueSyncOnAppend: false,
      diskQueuePath: path.join(dataDir, 'influx-queue.lines'),
      diskQueueFlushMs: 1000,
      diskQueueBatchMax: 500,
      diskQueueMaxLinesPerFile: 100000,
      clientBatchSize: 500,
      clientFlushIntervalMs: 1000,
      auditMaxFieldLength: 4096,
      logWrites: false,
    };

    service = new InfluxService(config);
  });

  afterEach(async () => {
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  });

  async function readUsageCsv(): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return fs.readFileSync(path.join(dataDir, 'influx_usage.csv'), 'utf8');
  }

  it('logs writePoint and flush on writeIgMetrics', async () => {
    await service.writeIgMetrics({
      deviceId: 'dev-1',
      igId: 'ig-1',
      trigger: 'api_poll',
      followersCount: 100,
    });

    const csv = await readUsageCsv();
    expect(csv).toContain('write,writePoint,metrics');
    expect(csv).toContain('write,flush,metrics');
  });

  it('logs Flux queries from queryFlux', async () => {
    await service.queryFlux('from(bucket: "metrics") |> range(start: -1h) |> limit(n:1)');

    const csv = await readUsageCsv();
    expect(csv).toContain('read,query,metrics');
    expect(mockQueryRows).toHaveBeenCalled();
  });
});
