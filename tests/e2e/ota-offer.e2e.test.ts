import './helpers/registerDeviceCertificateMock';
import request from 'supertest';
import express from 'express';
import { createOtaRoutes } from '@/routes/otaRoutes';

jest.mock('@/middleware/mtlsAuth', () => ({
  requireMtlsDeviceCert: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { deviceId: string }).deviceId = 'device-e2e-1';
    next();
  }
}));

jest.mock('@/models/Device', () => ({
  Device: {
    findOne: jest.fn().mockResolvedValue({ firmwareVersion: '4.3.0' })
  }
}));

jest.mock('@/models/FirmwareRelease', () => ({
  FirmwareRelease: { findOne: jest.fn() },
  FirmwareReleaseStatus: { STABLE: 'stable' }
}));

describe('E2E OTA device offer flow', () => {
  const origTestOta = process.env.TEST_OTA;

  beforeEach(() => {
    delete process.env.TEST_OTA;
  });

  afterAll(() => {
    if (origTestOta === undefined) delete process.env.TEST_OTA;
    else process.env.TEST_OTA = origTestOta;
  });
  it('returns offer when resolveUpdate matches requested version', async () => {
    const mockResolve = jest.fn().mockResolvedValue({
      version: '4.3.1',
      downloadUrl: 'https://example.com/firmware.bin',
      sha256: 'a'.repeat(64),
      signature: 'sig',
      sizeBytes: 1000,
      expiresAt: new Date().toISOString()
    });

    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1',
      createOtaRoutes({
        otaConfig: {
          enabled: true,
          oci: {
            namespace: 'ns',
            bucket: 'bucket',
            region: 'ap-hyderabad-1',
            parBaseUrl: 'https://ns.objectstorage.ap-hyderabad-1.oci.customer-oci.com'
          },
          presignedUrlTtlSec: 900,
          signingConfirmed: true,
          broadcastTopic: 'proof.mqtt/broadcast/cmd',
          downloadMode: 'presigned',
          checkRateLimitSec: 0,
          rollbackFailureThreshold: 3
        },
        otaService: { resolveUpdate: mockResolve } as never,
        storage: {} as never,
        eventHandler: { handle: jest.fn() } as never,
        getRedisClient: () => null,
        redisKeyPrefix: 'e2e:'
      })
    );

    const res = await request(app).get('/api/v1/ota/offer/4.3.1').expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.version).toBe('4.3.1');
    expect(res.body.download_url).toBe('https://example.com/firmware.bin');
    expect(mockResolve).toHaveBeenCalledWith({
      deviceId: 'device-e2e-1',
      currentVersion: '4.3.0'
    });
  });
});
