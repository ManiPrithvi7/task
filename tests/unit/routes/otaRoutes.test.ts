import express from 'express';
import request from 'supertest';
import { createOtaRoutes } from '@/routes/otaRoutes';

jest.mock('@/middleware/mtlsAuth', () => ({
  requireMtlsDeviceCert: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { deviceId: string }).deviceId = 'dev-1';
    next();
  }
}));

jest.mock('@/services/auditService', () => ({
  AuditEventType: { OTA_CHECK_NO_UPDATE: 'OTA_CHECK_NO_UPDATE', OTA_CHECK_OFFERED: 'OTA_CHECK_OFFERED' },
  getAuditService: () => null
}));

const mockResolveUpdate = jest.fn();
const mockHandle = jest.fn();

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1',
    createOtaRoutes({
      otaConfig: {
        enabled: true,
        oci: { namespace: 'ns', bucket: 'firmware-bucket', region: 'ap-hyderabad-1' },
        presignedUrlTtlSec: 900,
        signingConfirmed: false,
        checkOnRegistration: false,
        broadcastTopic: 'proof.mqtt/broadcast/cmd',
        downloadMode: 'presigned',
        checkRateLimitSec: 0,
        rollbackFailureThreshold: 3
      },
      otaService: { resolveUpdate: mockResolveUpdate } as never,
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

  it('returns 400 without current_version', async () => {
    const res = await request(buildApp()).get('/api/v1/ota/check');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_CURRENT_VERSION');
  });

  it('returns no update when resolveUpdate is null', async () => {
    mockResolveUpdate.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/v1/ota/check?current_version=4.3.0');
    expect(res.status).toBe(200);
    expect(res.body.update_available).toBe(false);
  });

  it('returns offer when update available', async () => {
    mockResolveUpdate.mockResolvedValue({
      version: '4.3.1',
      downloadUrl: 'https://s3.example/bin',
      sha256: 'abc',
      signature: 'sig',
      sizeBytes: 1234,
      expiresAt: '2026-06-12T00:00:00.000Z'
    });
    const res = await request(buildApp()).get('/api/v1/ota/check?current_version=4.3.0');
    expect(res.status).toBe(200);
    expect(res.body.update_available).toBe(true);
    expect(res.body.version).toBe('4.3.1');
    expect(res.body.download_url).toBe('https://s3.example/bin');
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
