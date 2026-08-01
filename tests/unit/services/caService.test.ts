import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as forge from 'node-forge';
import mongoose from 'mongoose';
import {
  CAService,
  DeviceAlreadyHasCertificateError,
  UnsupportedCSRKeyTypeError
} from '@/services/caService';
import { DeviceCertificate } from '@/models/DeviceCertificate';

jest.mock('@/services/auditService', () => ({
  getAuditService: jest.fn().mockReturnValue(null),
  AuditEventType: {}
}));

jest.mock('@/services/transparencyLog', () => ({
  getTransparencyLog: jest.fn().mockReturnValue(null)
}));

jest.mock('@/models/DeviceCertificate', () => ({
  DeviceCertificate: {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn()
  },
  DeviceCertificateStatus: {
    active: 'active',
    revoked: 'revoked',
    expired: 'expired'
  }
}));

function makeCsrPem(cn: string, keyBits = 2048): string {
  const keys = forge.pki.rsa.generateKeyPair(keyBits);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: 'commonName', value: cn }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificationRequestToPem(csr);
}

function mockFindOneResolved(doc: unknown) {
  (DeviceCertificate.findOne as jest.Mock).mockReturnValue({
    sort: jest.fn().mockResolvedValue(doc)
  });
}

describe('CAService.formatExpectedCN', () => {
  const prevPrefix = process.env.CERT_CN_PREFIX;

  afterEach(() => {
    if (prevPrefix === undefined) delete process.env.CERT_CN_PREFIX;
    else process.env.CERT_CN_PREFIX = prevPrefix;
  });

  const ca = () =>
    new CAService({
      storagePath: os.tmpdir(),
      rootCAValidityYears: 1,
      deviceCertValidityDays: 90
    });

  it('prefixes default PROOF and avoids double-prefix', () => {
    delete process.env.CERT_CN_PREFIX;
    expect(ca().formatExpectedCN('ADMIN-123')).toBe('PROOF-ADMIN-123');
    expect(ca().formatExpectedCN('PROOF-ADMIN-123')).toBe('PROOF-ADMIN-123');
    expect(ca().formatExpectedCN('PROOF_ADMIN-123')).toBe('PROOF-ADMIN-123');
  });

  it('strips trailing separators from CERT_CN_PREFIX', () => {
    process.env.CERT_CN_PREFIX = 'PROOF-';
    expect(ca().formatExpectedCN('ADMIN-123')).toBe('PROOF-ADMIN-123');
  });

  it('uses custom CERT_CN_PREFIX', () => {
    process.env.CERT_CN_PREFIX = 'ACME';
    expect(ca().formatExpectedCN('DEV-1')).toBe('ACME-DEV-1');
  });

  it('empty deviceId yields prefix-only CN', () => {
    delete process.env.CERT_CN_PREFIX;
    expect(ca().formatExpectedCN('')).toBe('PROOF-');
  });
});

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
    jest.clearAllMocks();
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

describe('CAService.signCSR DB paths', () => {
  let tmpDir: string;
  let ca: CAService;
  let readyStateDesc: PropertyDescriptor | undefined;
  const userId = '507f1f77bcf86cd799439011';
  const prevAllow = process.env.ALLOW_ONBOARDING_WITH_ACTIVE_CERT;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-db-'));
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
    delete process.env.ALLOW_ONBOARDING_WITH_ACTIVE_CERT;
    readyStateDesc = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
    Object.defineProperty(mongoose.connection, 'readyState', {
      configurable: true,
      get: () => 1
    });
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (readyStateDesc) {
      Object.defineProperty(mongoose.connection, 'readyState', readyStateDesc);
    } else {
      Object.defineProperty(mongoose.connection, 'readyState', {
        configurable: true,
        value: 0
      });
    }
    if (prevAllow === undefined) delete process.env.ALLOW_ONBOARDING_WITH_ACTIVE_CERT;
    else process.env.ALLOW_ONBOARDING_WITH_ACTIVE_CERT = prevAllow;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects when active primary exists and replace not allowed', async () => {
    const deviceId = 'device-has-primary';
    const existingId = new mongoose.Types.ObjectId();
    mockFindOneResolved({ _id: existingId, device_id: deviceId, slot: 'primary' });

    const cn = ca.formatExpectedCN(deviceId);
    await expect(ca.signCSR(makeCsrPem(cn), deviceId, userId, { allowReplacePrimary: false })).rejects.toMatchObject({
      name: 'DeviceAlreadyHasCertificateError',
      certificateId: existingId.toString()
    });
    expect(DeviceCertificate.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('upserts when allowReplacePrimary is true', async () => {
    const deviceId = 'device-replace-ok';
    mockFindOneResolved(null);
    const stored = {
      _id: new mongoose.Types.ObjectId(),
      device_id: deviceId,
      slot: 'primary',
      certificate: 'pem'
    };
    (DeviceCertificate.findOneAndUpdate as jest.Mock).mockResolvedValue(stored);

    const cn = ca.formatExpectedCN(deviceId);
    const doc = await ca.signCSR(makeCsrPem(cn), deviceId, userId, { allowReplacePrimary: true });
    expect(doc).toBe(stored);
    expect(DeviceCertificate.findOneAndUpdate).toHaveBeenCalledWith(
      { device_id: deviceId, slot: 'primary' },
      expect.objectContaining({ $set: expect.objectContaining({ cn, slot: 'primary' }) }),
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  });

  it('staging slot skips replace-primary guard', async () => {
    const deviceId = 'device-staging';
    mockFindOneResolved({ _id: new mongoose.Types.ObjectId(), slot: 'primary' });
    const stored = { _id: new mongoose.Types.ObjectId(), device_id: deviceId, slot: 'staging' };
    (DeviceCertificate.findOneAndUpdate as jest.Mock).mockResolvedValue(stored);

    const cn = ca.formatExpectedCN(deviceId);
    const doc = await ca.signCSR(makeCsrPem(cn), deviceId, userId, { slot: 'staging' });
    expect(doc).toBe(stored);
    expect(DeviceCertificate.findOneAndUpdate).toHaveBeenCalledWith(
      { device_id: deviceId, slot: 'staging' },
      expect.any(Object),
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  });

  it('falls back to device_id-only update on legacy E11000', async () => {
    const deviceId = 'device-e11000';
    mockFindOneResolved(null);
    const stored = { _id: new mongoose.Types.ObjectId(), device_id: deviceId, slot: 'primary' };
    (DeviceCertificate.findOneAndUpdate as jest.Mock)
      .mockRejectedValueOnce(
        new Error('E11000 duplicate key error collection: device_certificates index: device_id_1 dup key: { device_id: "x" }')
      )
      .mockResolvedValueOnce(stored);

    const cn = ca.formatExpectedCN(deviceId);
    const doc = await ca.signCSR(makeCsrPem(cn), deviceId, userId, { allowReplacePrimary: true });
    expect(doc).toBe(stored);
    expect(DeviceCertificate.findOneAndUpdate).toHaveBeenNthCalledWith(
      1,
      { device_id: deviceId, slot: 'primary' },
      expect.any(Object),
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    expect(DeviceCertificate.findOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      { device_id: deviceId },
      expect.any(Object),
      { upsert: false, new: true }
    );
  });

  it('rethrows original E11000 when fallback update returns null', async () => {
    const deviceId = 'device-e11000-null';
    mockFindOneResolved(null);
    const err = new Error(
      'E11000 duplicate key error collection: device_certificates index: device_certificates_device_id_key'
    );
    (DeviceCertificate.findOneAndUpdate as jest.Mock)
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(null);

    const cn = ca.formatExpectedCN(deviceId);
    await expect(ca.signCSR(makeCsrPem(cn), deviceId, userId, { allowReplacePrimary: true })).rejects.toBe(err);
  });

  it('rethrows non-device_id E11000 without fallback', async () => {
    const deviceId = 'device-e11000-fp';
    mockFindOneResolved(null);
    const err = new Error('E11000 duplicate key index: fingerprint_1');
    (DeviceCertificate.findOneAndUpdate as jest.Mock).mockRejectedValueOnce(err);

    const cn = ca.formatExpectedCN(deviceId);
    await expect(ca.signCSR(makeCsrPem(cn), deviceId, userId, { allowReplacePrimary: true })).rejects.toBe(err);
    expect(DeviceCertificate.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('UnsupportedCSRKeyTypeError', () => {
  it('has expected name', () => {
    const err = new UnsupportedCSRKeyTypeError();
    expect(err.name).toBe('UnsupportedCSRKeyTypeError');
  });
});

describe('DeviceAlreadyHasCertificateError', () => {
  it('has expected name and certificateId', () => {
    const err = new DeviceAlreadyHasCertificateError('msg', 'cert-id');
    expect(err.name).toBe('DeviceAlreadyHasCertificateError');
    expect(err.certificateId).toBe('cert-id');
  });
});
