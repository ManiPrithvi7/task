import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { InfluxDB } from '@influxdata/influxdb-client';
import { DASHBOARD_FLUX_ROW_LIMIT, InfluxService } from '@/services/influxService';
import type { InfluxDBConfig } from '@/config';

describe('InfluxService dashboard Flux row cap', () => {
  let dataDir: string;
  let service: InfluxService;

  beforeEach(async () => {
    dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'influx-dash-limit-'));
    (InfluxDB as jest.Mock).mockImplementation(() => ({
      getWriteApi: jest.fn().mockReturnValue({
        writePoint: jest.fn(),
        writeRecords: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
        useDefaultTags: jest.fn()
      }),
      getQueryApi: jest.fn().mockReturnValue({
        queryRows: jest.fn((_q: string, handlers: { complete: () => void }) => {
          handlers.complete();
        })
      })
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
      logWrites: false
    };
    service = new InfluxService(config);
  });

  afterEach(async () => {
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  });

  it(`caps unbounded dashboard series at limit(n: ${DASHBOARD_FLUX_ROW_LIMIT})`, async () => {
    const spy = jest.spyOn(service, 'queryFlux').mockResolvedValue([]);

    await service.queryIgMetrics('dev-1', '-90d');
    await service.queryIgMilestones('dev-1', '-90d');
    await service.queryGmbMetrics('loc-1', '-90d');
    await service.queryGmbMilestones('loc-1', '-90d');

    expect(spy).toHaveBeenCalledTimes(4);
    for (const [flux] of spy.mock.calls) {
      expect(flux).toContain(`|> limit(n: ${DASHBOARD_FLUX_ROW_LIMIT})`);
    }
  });
});
