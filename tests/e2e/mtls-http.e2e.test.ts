import * as crypto from 'crypto';
import * as forge from 'node-forge';
import type { NextFunction, Request, Response } from 'express';
import { requireMtlsDeviceCert } from '@/middleware/mtlsAuth';

jest.mock('@/models/DeviceCertificate', () => ({
  DeviceCertificate: {
    findOne: jest.fn()
  },
  DeviceCertificateStatus: { active: 'active' }
}));

import { DeviceCertificate } from '@/models/DeviceCertificate';

const mockFindOne = DeviceCertificate.findOne as jest.Mock;

function buildTestCert(cn: string) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  cert.setSubject([{ name: 'commonName', value: cn }]);
  cert.setIssuer([{ name: 'commonName', value: cn }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const pem = forge.pki.certificateToPem(cert);
  const fp = new crypto.X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();
  return { pem, fp };
}

async function invokeMtls(
  headers: Record<string, string>,
  findOneImpl: jest.Mock
) {
  mockFindOne.mockImplementation(findOneImpl);
  const req = {
    headers,
    get(name: string) {
      return headers[name.toLowerCase()] ?? headers[name];
    }
  } as unknown as Request;
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = jest.fn((c: number) => {
    res.statusCode = c;
    return res;
  }) as Response['status'];
  res.json = jest.fn((b: unknown) => {
    res.body = b;
    return res;
  }) as Response['json'];
  const next = jest.fn() as NextFunction;
  await requireMtlsDeviceCert()(req, res as Response, next);
  return {
    statusCode: res.statusCode,
    body: res.body as { code?: string },
    nextCalled: next.mock.calls.length > 0,
    req
  };
}

describe('E2E mTLS HTTP gate', () => {
  const origPrefix = process.env.CERT_CN_PREFIX;

  beforeEach(() => {
    process.env.CERT_CN_PREFIX = 'PROOF';
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (origPrefix === undefined) delete process.env.CERT_CN_PREFIX;
    else process.env.CERT_CN_PREFIX = origPrefix;
  });

  it('accepts request when cert fingerprint matches Mongo record', async () => {
    const { pem, fp } = buildTestCert('PROOF_device-1');
    const result = await invokeMtls(
      { 'x-forwarded-client-cert': pem },
      jest.fn().mockResolvedValue({ fingerprint: fp, slot: 'primary' })
    );
    expect(result.nextCalled).toBe(true);
    expect((result.req as Request & { deviceId?: string }).deviceId).toBeTruthy();
  });

  it('rejects fingerprint mismatch with 403', async () => {
    const { pem } = buildTestCert('PROOF_device-1');
    const result = await invokeMtls(
      { 'x-forwarded-client-cert': pem },
      jest.fn().mockResolvedValue({ fingerprint: 'deadbeef', slot: 'primary' })
    );
    expect(result.nextCalled).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(result.body?.code).toBe('CERT_FINGERPRINT_MISMATCH');
  });

  it('returns 503 when certificate lookup throws', async () => {
    const { pem } = buildTestCert('PROOF_device-1');
    const result = await invokeMtls(
      { 'x-forwarded-client-cert': pem },
      jest.fn().mockRejectedValue(new Error('mongo blip'))
    );
    expect(result.nextCalled).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(result.body?.code).toBe('CERT_LOOKUP_UNAVAILABLE');
  });
});
