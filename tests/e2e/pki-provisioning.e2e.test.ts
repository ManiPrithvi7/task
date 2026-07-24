import './helpers/registerDeviceCertificateMock';
import request from 'supertest';
import { createE2eApp, TEST_DEVICE_ID, TEST_USER_ID } from './helpers/buildTestApp';
import { TEST_ADMIN_BEARER, TEST_PROVISIONING_TOKEN } from './helpers/authFixtures';
import { SAMPLE_CSR_PEM, SAMPLE_CERT_ID, sampleCertificateDoc } from './helpers/pkiFixtures';
import { createProvisioningRoutes } from '@/routes/provisioningRoutes';

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

function buildPkiApp() {
  const app = createE2eApp();
  app.use(
    '/api/v1',
    createProvisioningRoutes({
      provisioningService: {
        issueToken: jest.fn().mockResolvedValue(TEST_PROVISIONING_TOKEN),
        getTokenTTL: jest.fn().mockReturnValue(600),
        peekToken: jest.fn().mockResolvedValue({
          valid: true,
          deviceId: TEST_DEVICE_ID,
          userId: TEST_USER_ID
        }),
        revokeToken: jest.fn(),
        finalizeTokenAfterSuccessfulSignCsr: jest.fn().mockResolvedValue(undefined),
        peekTokenForDownload: jest.fn()
      } as never,
      caService: {
        findActiveCertificateByDeviceId: jest.fn().mockResolvedValue(null),
        signCSR: jest.fn().mockResolvedValue(sampleCertificateDoc()),
        getRootCACertificate: jest.fn().mockReturnValue('ca-pem'),
        findCertificateById: jest.fn(),
        findCertificateByDeviceId: jest.fn(),
        updateCertificateStatus: jest.fn()
      } as never,
      authService: {
        verifyAuthToken: jest.fn().mockResolvedValue({ valid: true, userId: TEST_USER_ID })
      } as never,
      userService: {
        verifyUserExists: jest.fn().mockResolvedValue({
          found: true,
          user: { email: 'e2e@example.com' }
        }),
        verifyDeviceUserAssociation: jest.fn()
      } as never
    })
  );
  return app;
}

describe('E2E PKI provisioning flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeviceFindOne.mockResolvedValue({
      userId: { toString: () => TEST_USER_ID },
      status: 'PROVISIONING',
      save: jest.fn().mockResolvedValue(undefined)
    });
  });

  it('onboarding → sign-csr returns certificate and HTTPS download URL', async () => {
    const app = buildPkiApp();

    const onboarding = await request(app)
      .post('/api/v1/onboarding')
      .set('Authorization', `Bearer ${TEST_ADMIN_BEARER}`)
      .send({ device_id: TEST_DEVICE_ID })
      .expect(200);

    expect(onboarding.body.provisioning_token).toBe(TEST_PROVISIONING_TOKEN);

    const signCsr = await request(app)
      .post('/api/v1/sign-csr')
      .set('Authorization', `Bearer ${TEST_PROVISIONING_TOKEN}`)
      .set('Host', 'provision.example.com')
      .send({ csr: SAMPLE_CSR_PEM })
      .expect(200);

    expect(signCsr.body.success).toBe(true);
    expect(signCsr.body.certificate).toContain('BEGIN CERTIFICATE');
    expect(signCsr.body.downloadUrl).toBe(
      `https://provision.example.com/api/v1/certificates/${SAMPLE_CERT_ID}/download`
    );
  });
});
