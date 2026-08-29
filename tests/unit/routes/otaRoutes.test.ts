import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { createOtaRoutes } from '@/routes/otaRoutes';

jest.mock('@/middleware/mtlsAuth', () => ({
  requireMtlsDeviceCert: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { deviceId: string }).deviceId = 'dev-1';
    next();
  }
}));

const mockHandle = jest.fn();

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1',
    createOtaRoutes({
      otaConfig: {
        enabled: true,
        oci: {
          namespace: 'ns',
          bucket: 'firmware-bucket',
          region: 'ap-hyderabad-1',
          parBaseUrl: 'https://ns.objectstorage.ap-hyderabad-1.oci.customer-oci.com'
        },
        presignedUrlTtlSec: 900,
        signingConfirmed: false,
        broadcastTopic: 'proof.mqtt/broadcast/cmd',
        downloadMode: 'presigned',
        checkRateLimitSec: 0,
        rollbackFailureThreshold: 3
      },
      otaService: {} as never,
      storage: {} as never,
      eventHandler: { handle: mockHandle } as never,
      getRedisClient: () => null,
      redisKeyPrefix: 'test:'
    })
  );
  return app;
}

describe('otaRoutes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('accepts POST /ota/report', async () => {
    mockHandle.mockResolvedValue(undefined);
    const res = await request(buildApp())
      .post('/api/v1/ota/report')
      .send({ type: 'ota_rollback', attempted_version: '4.3.1' });
    expect(res.status).toBe(200);
    expect(mockHandle).toHaveBeenCalledWith('dev-1', expect.objectContaining({ type: 'ota_rollback' }));
  });

  it('serves proof:1.0.1 download without mTLS', async () => {
    const fixture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ota-fw-')), 'fixture.ino.bin');
    fs.writeFileSync(fixture, Buffer.alloc(1024, 1));
    process.env.TEST_OTA_FIRMWARE_PATH = fixture;
    try {
      const res = await request(buildApp()).get('/api/v1/ota/download/proof%3A1.0.1');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/octet-stream/);
      expect(res.headers['x-firmware-version']).toBe('proof:1.0.1');
      expect(Number(res.headers['content-length'])).toBeGreaterThan(0);
    } finally {
      delete process.env.TEST_OTA_FIRMWARE_PATH;
      fs.rmSync(path.dirname(fixture), { recursive: true, force: true });
    }
  });
});
