import express from 'express';
import request from 'supertest';
import { createProvisioningRoutes } from '@/routes/provisioningRoutes';
import type { ProvisioningDependencies } from '@/routes/provisioningRoutes';

jest.mock('@/models/Device', () => ({
  Device: {
    findOne: jest.fn(),
    updateOne: jest.fn()
  },
  DeviceStatus: { PROVISIONING: 'PROVISIONING', UNALLOCATED: 'UNALLOCATED' }
}));

function buildProvisioningRoutesApp(overrides?: Partial<ProvisioningDependencies>) {
  const app = express();
  app.use(express.json());

  const deps: ProvisioningDependencies = {
    provisioningService: {
      issueToken: jest.fn().mockResolvedValue('prov-token-123'),
      getTokenTTL: jest.fn().mockReturnValue(300),
      peekToken: jest.fn(),
      revokeToken: jest.fn(),
      finalizeTokenAfterSuccessfulSignCsr: jest.fn(),
      peekTokenForDownload: jest.fn()
    } as unknown as ProvisioningDependencies['provisioningService'],
    caService: {
      findActiveCertificateByDeviceId: jest.fn().mockResolvedValue(null),
      signCSR: jest.fn(),
      getRootCACertificate: jest.fn().mockReturnValue('ca-pem'),
      findCertificateById: jest.fn(),
      findCertificateByDeviceId: jest.fn(),
      updateCertificateStatus: jest.fn()
    } as unknown as ProvisioningDependencies['caService'],
    authService: {
      verifyAuthToken: jest.fn().mockResolvedValue({ valid: true, userId: '507f1f77bcf86cd799439011' })
    } as unknown as ProvisioningDependencies['authService'],
    userService: {
      verifyUserExists: jest.fn().mockResolvedValue({
        found: true,
        user: { email: 'user@example.com' }
      }),
      verifyDeviceUserAssociation: jest.fn()
    } as unknown as ProvisioningDependencies['userService'],
    ...overrides
  };

  app.use('/api/v1', createProvisioningRoutes(deps));
  return { app, deps };
}

describe('provisioningRoutes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when auth token missing on onboarding', async () => {
    const { app } = buildProvisioningRoutesApp();
    const res = await request(app)
      .post('/api/v1/onboarding')
      .send({ device_id: 'device-1' })
      .expect(401);

    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('AUTH_TOKEN_MISSING');
  });

  it('returns 401 when auth token invalid on onboarding', async () => {
    const { app, deps } = buildProvisioningRoutesApp();
    (deps.authService.verifyAuthToken as jest.Mock).mockResolvedValue({
      valid: false,
      error: 'Invalid token'
    });

    const res = await request(app)
      .post('/api/v1/onboarding')
      .set('Authorization', 'Bearer invalid-token')
      .send({ device_id: 'device-1' })
      .expect(401);

    expect(res.body.code).toBe('AUTH_TOKEN_INVALID');
  });

  it('returns 400 when device_id missing on onboarding', async () => {
    const { app } = buildProvisioningRoutesApp();
    const res = await request(app)
      .post('/api/v1/onboarding')
      .set('Authorization', 'Bearer valid-token')
      .send({})
      .expect(400);

    expect(res.body.code).toBe('DEVICE_ID_REQUIRED');
  });

  it('returns 200 and provisioning token on successful onboarding', async () => {
    const { app, deps } = buildProvisioningRoutesApp();
    const res = await request(app)
      .post('/api/v1/onboarding')
      .set('Authorization', 'Bearer valid-token')
      .send({ device_id: 'device-1' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.provisioning_token).toBe('prov-token-123');
    expect(res.body.device_id).toBe('device-1');
    expect(deps.provisioningService.issueToken).toHaveBeenCalledWith(
      'device-1',
      '507f1f77bcf86cd799439011'
    );
  });

  it('returns 401 when provisioning token missing on sign-csr', async () => {
    const { app } = buildProvisioningRoutesApp();
    const res = await request(app)
      .post('/api/v1/sign-csr')
      .send({ csr: 'test-csr' })
      .expect(401);

    expect(res.body.code).toBe('TOKEN_MISSING');
  });
});
