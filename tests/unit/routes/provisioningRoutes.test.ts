import express from 'express';
import request from 'supertest';
import { createProvisioningRoutes } from '@/routes/provisioningRoutes';
import type { ProvisioningDependencies } from '@/routes/provisioningRoutes';

const mockDeviceFindOne = jest.fn();

jest.mock('@/models/Device', () => {
  const DeviceModel = jest.fn().mockImplementation((doc: Record<string, unknown>) => ({
    ...doc,
    save: jest.fn().mockResolvedValue(undefined)
  }));
  (DeviceModel as unknown as { findOne: jest.Mock }).findOne = mockDeviceFindOne;
  return {
    Device: DeviceModel,
    DeviceStatus: { PROVISIONING: 'PROVISIONING', UNALLOCATED: 'UNALLOCATED' }
  };
});

import { Device } from '@/models/Device';

function buildProvisioningRoutesApp(overrides?: Partial<ProvisioningDependencies>) {
  const app = express();
  app.set('trust proxy', 1);
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'protocol', { value: 'https' });
    next();
  });
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
    mockDeviceFindOne.mockResolvedValue({
      userId: { toString: () => '507f1f77bcf86cd799439011' },
      status: 'PROVISIONING',
      save: jest.fn().mockResolvedValue(undefined)
    });
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

  it('returns 200 on sign-csr with downloadUrl built from req.protocol', async () => {
    const certId = '507f1f77bcf86cd799439012';
    const { app, deps } = buildProvisioningRoutesApp({
      provisioningService: {
        issueToken: jest.fn(),
        getTokenTTL: jest.fn().mockReturnValue(300),
        peekToken: jest.fn().mockResolvedValue({
          valid: true,
          deviceId: 'device-1',
          userId: '507f1f77bcf86cd799439011'
        }),
        revokeToken: jest.fn(),
        finalizeTokenAfterSuccessfulSignCsr: jest.fn().mockResolvedValue(undefined),
        peekTokenForDownload: jest.fn()
      } as unknown as ProvisioningDependencies['provisioningService'],
      caService: {
        findActiveCertificateByDeviceId: jest.fn().mockResolvedValue(null),
        signCSR: jest.fn().mockResolvedValue({
          _id: { toString: () => certId },
          certificate: 'cert-pem',
          expires_at: new Date('2030-01-01T00:00:00.000Z'),
          fingerprint: 'fp-1'
        }),
        getRootCACertificate: jest.fn().mockReturnValue('ca-pem'),
        findCertificateById: jest.fn(),
        findCertificateByDeviceId: jest.fn(),
        updateCertificateStatus: jest.fn()
      } as unknown as ProvisioningDependencies['caService']
    });

    const csrPem =
      '-----BEGIN CERTIFICATE REQUEST-----\nMIIBdummy\n-----END CERTIFICATE REQUEST-----';

    const res = await request(app)
      .post('/api/v1/sign-csr')
      .set('Authorization', 'Bearer prov-token-123')
      .set('Host', 'api.example.com')
      .send({ csr: csrPem })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.downloadUrl).toBe(
      `https://api.example.com/api/v1/certificates/${certId}/download`
    );
    expect(deps.caService.signCSR).toHaveBeenCalled();
  });
});
