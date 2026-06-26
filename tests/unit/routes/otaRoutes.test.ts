import express from 'express';
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
});
