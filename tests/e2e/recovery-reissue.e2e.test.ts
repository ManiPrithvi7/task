import request from 'supertest';
import { createE2eApp, TEST_DEVICE_ID } from './helpers/buildTestApp';
import { TEST_RECOVERY_TOKEN } from './helpers/authFixtures';
import { SAMPLE_CSR_PEM } from './helpers/pkiFixtures';
import { createLifecycleRoutes } from '@/routes/lifecycleRoutes';

jest.mock('@/models/Device', () => ({
  Device: {
    findOne: jest.fn().mockResolvedValue({
      clientId: TEST_DEVICE_ID,
      businessId: '507f1f77bcf86cd799439011'
    }),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 })
  },
  DeviceStatus: { ACTIVE: 'ACTIVE' }
}));

describe('E2E recovery reissue flow', () => {
  it('reissues certificate when recovery session is valid', async () => {
    const app = createE2eApp();
    app.use(
      '/api/v1',
      createLifecycleRoutes({
        caService: {
          revokeAllDeviceCertificates: jest.fn().mockResolvedValue(1),
          signCSR: jest.fn().mockResolvedValue({
            slot: 'primary',
            certificate: 'cert-pem',
            expires_at: new Date('2030-01-01'),
            fingerprint: 'fp1'
          }),
          getRootCACertificate: jest.fn().mockReturnValue('ca-pem'),
          promoteStagingToPrimary: jest.fn()
        } as never,
        recoverySessionService: {
          isAvailable: jest.fn().mockReturnValue(true),
          verifySession: jest.fn().mockResolvedValue({ ok: true }),
          consumeSession: jest.fn().mockResolvedValue(undefined)
        } as never
      })
    );

    const res = await request(app)
      .post('/api/v1/certificates/reissue')
      .send({
        device_id: TEST_DEVICE_ID,
        csr: SAMPLE_CSR_PEM,
        recovery_token: TEST_RECOVERY_TOKEN
      })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.device_id).toBe(TEST_DEVICE_ID);
    expect(res.body.certificate).toBe('cert-pem');
  });

  it('rejects invalid recovery token', async () => {
    const app = createE2eApp();
    app.use(
      '/api/v1',
      createLifecycleRoutes({
        caService: {
          revokeAllDeviceCertificates: jest.fn(),
          signCSR: jest.fn(),
          getRootCACertificate: jest.fn(),
          promoteStagingToPrimary: jest.fn()
        } as never,
        recoverySessionService: {
          isAvailable: jest.fn().mockReturnValue(true),
          verifySession: jest.fn().mockResolvedValue({ ok: false, error: 'RECOVERY_TOKEN_INVALID' }),
          consumeSession: jest.fn()
        } as never
      })
    );

    const res = await request(app)
      .post('/api/v1/certificates/reissue')
      .send({
        device_id: TEST_DEVICE_ID,
        csr: SAMPLE_CSR_PEM,
        recovery_token: 'invalid-token'
      });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.success).toBe(false);
  });
});
