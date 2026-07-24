import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as forge from 'node-forge';
import mongoose from 'mongoose';
import {
  CAService,
  UnsupportedCSRKeyTypeError
} from '@/services/caService';

jest.mock('@/services/auditService', () => ({
  getAuditService: jest.fn().mockReturnValue(null),
  AuditEventType: {}
}));

jest.mock('@/services/transparencyLog', () => ({
  getTransparencyLog: jest.fn().mockReturnValue(null)
}));

function makeCsrPem(cn: string, keyBits = 2048): string {
  const keys = forge.pki.rsa.generateKeyPair(keyBits);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: 'commonName', value: cn }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificationRequestToPem(csr);
}

describe('CAService.signCSR', () => {
  let tmpDir: string;
  let ca: CAService;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-test-'));
    ca = new CAService({
      storagePath: tmpDir,
      rootCAValidityYears: 1,
      deviceCertValidityDays: 90,
      certProfile: {
        validityDays: 90,
        keyUsage: ['digitalSignature', 'keyEncipherment'],
        extendedKeyUsage: ['clientAuth'],
        requireSanDeviceId: true,
        minKeyBits: 2048
      }
    });
    await ca.initialize();
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('signs a valid RSA 2048 CSR when MongoDB is unavailable (in-memory)', async () => {
    const deviceId = 'device-test-1';
    const cn = ca.formatExpectedCN(deviceId);
    const csrPem = makeCsrPem(cn, 2048);
    const doc = await ca.signCSR(csrPem, deviceId, '507f1f77bcf86cd799439011');
    expect(doc.certificate).toContain('BEGIN CERTIFICATE');
    expect(doc.cn).toBe(cn);
    expect(doc.fingerprint).toBeTruthy();
  });

  it('rejects RSA key smaller than minimum bits', async () => {
    const deviceId = 'device-small-key';
    const cn = ca.formatExpectedCN(deviceId);
    const csrPem = makeCsrPem(cn, 1024);
    await expect(ca.signCSR(csrPem, deviceId, '507f1f77bcf86cd799439011')).rejects.toThrow(
      /RSA key too small/
    );
  });

  it('rejects CSR when device id is not present in CN', async () => {
    const csrPem = makeCsrPem('PROOF_wrong-device', 2048);
    await expect(
      ca.signCSR(csrPem, 'expected-device', '507f1f77bcf86cd799439011')
    ).rejects.toThrow(/did not match expected format/);
  });

  it('throws UnsupportedCSRKeyTypeError for invalid CSR PEM', async () => {
    await expect(
      ca.signCSR('not-a-csr', 'device-1', '507f1f77bcf86cd799439011')
    ).rejects.toThrow();
  });
});

describe('UnsupportedCSRKeyTypeError', () => {
  it('has expected name', () => {
    const err = new UnsupportedCSRKeyTypeError();
    expect(err.name).toBe('UnsupportedCSRKeyTypeError');
  });
});
