import request from 'supertest';
import express from 'express';
import { createOtaRoutes } from '@/routes/otaRoutes';

import * as crypto from 'crypto';
import * as forge from 'node-forge';

jest.mock('@/models/DeviceCertificate', () => ({
  DeviceCertificate: {
    findOne: jest.fn()
  },
  DeviceCertificateStatus: { active: 'active' }
}));

import { DeviceCertificate } from '@/models/DeviceCertificate';

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
  const origPrefix = process.env.CERT_CN_PREFIX;

  beforeEach(async () => {
    delete process.env.TEST_OTA;
    process.env.CERT_CN_PREFIX = 'PROOF';

    // Generate a forwarded client cert header whose CN maps to deviceId "device-e2e-1".
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date(Date.now() + 86400000);
    cert.setSubject([{ name: 'commonName', value: 'PROOF_device-e2e-1' }]);
    cert.setIssuer([{ name: 'commonName', value: 'PROOF_device-e2e-1' }]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const pem = forge.pki.certificateToPem(cert);
    const fp = new crypto.X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();

    (DeviceCertificate.findOne as jest.Mock).mockResolvedValue({ fingerprint: fp, slot: 'primary' });

    // Store in closure via process.env so the request builder can access it.
    process.env.__E2E_CLIENT_CERT_PEM__ = pem;
  });

  afterAll(() => {
    if (origTestOta === undefined) delete process.env.TEST_OTA;
    else process.env.TEST_OTA = origTestOta;

    if (origPrefix === undefined) delete process.env.CERT_CN_PREFIX;
    else process.env.CERT_CN_PREFIX = origPrefix;
    delete process.env.__E2E_CLIENT_CERT_PEM__;
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

    const clientCertPem = process.env.__E2E_CLIENT_CERT_PEM__ as string;
    // HTTP header values cannot contain raw newlines. The middleware supports escaped "\n".
    const clientCertPemHeader = clientCertPem
      .replace(/\r/g, '')
      .replace(/\n/g, '\\n');
    const res = await request(app)
      .get('/api/v1/ota/offer/4.3.1')
      .set('x-forwarded-client-cert', clientCertPemHeader)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.version).toBe('4.3.1');
    expect(res.body.download_url).toBe('https://example.com/firmware.bin');
    expect(mockResolve).toHaveBeenCalledWith({
      deviceId: 'device-e2e-1',
      currentVersion: '4.3.0'
    });
  });
});
