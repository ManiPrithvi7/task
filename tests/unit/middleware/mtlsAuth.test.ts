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

function buildTestCertPem(cn: string): { pem: string; fingerprint256: string } {
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
  const x509 = new crypto.X509Certificate(pem);
  return { pem, fingerprint256: x509.fingerprint256 };
}

function createMockRes() {
  const res: Partial<Response> & {
    statusCode?: number;
    body?: unknown;
  } = {};
  res.status = jest.fn().mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  }) as Response['status'];
  res.json = jest.fn().mockImplementation((body: unknown) => {
    res.body = body;
    return res;
  }) as Response['json'];
  return res as Response & { statusCode?: number; body?: unknown };
}

async function runMiddleware(
  headers: Record<string, string>,
  findOneImpl: typeof mockFindOne
): Promise<{ statusCode?: number; body?: unknown; nextCalled: boolean; req: Request }> {
  mockFindOne.mockImplementation(findOneImpl);
  const req = {
    headers,
    get(name: string) {
      const key = name.toLowerCase();
      return headers[key] ?? headers[name] ?? undefined;
    }
  } as unknown as Request;
  const res = createMockRes();
  const next = jest.fn() as NextFunction;
  await requireMtlsDeviceCert()(req, res, next);
  return { statusCode: res.statusCode, body: res.body, nextCalled: next.mock.calls.length > 0, req };
}

describe('requireMtlsDeviceCert', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when client cert header is missing', async () => {
    const result = await runMiddleware({}, mockFindOne);
    expect(result.statusCode).toBe(401);
    expect((result.body as { code: string }).code).toBe('MTLS_REQUIRED');
    expect(result.nextCalled).toBe(false);
  });

  it('returns 403 when no active certificate is found', async () => {
    const { pem } = buildTestCertPem('PROOF_device-1');
    const result = await runMiddleware(
      { 'x-forwarded-client-cert': pem },
      jest.fn().mockResolvedValue(null)
    );
    expect(result.statusCode).toBe(403);
    expect((result.body as { code: string }).code).toBe('CERT_NOT_ACTIVE');
  });

  it('returns 403 on fingerprint mismatch', async () => {
    const { pem } = buildTestCertPem('PROOF_device-1');
    const result = await runMiddleware({ 'x-forwarded-client-cert': pem }, jest.fn().mockResolvedValue({
      fingerprint: 'deadbeef',
      slot: 'primary'
    }));
    expect(result.statusCode).toBe(403);
    expect((result.body as { code: string }).code).toBe('CERT_FINGERPRINT_MISMATCH');
  });

  it('calls next when fingerprint matches', async () => {
    const { pem, fingerprint256 } = buildTestCertPem('PROOF_device-1');
    const normalized = fingerprint256.replace(/:/g, '').toLowerCase();
    const result = await runMiddleware({ 'x-forwarded-client-cert': pem }, jest.fn().mockResolvedValue({
      fingerprint: normalized,
      slot: 'primary'
    }));
    expect(result.nextCalled).toBe(true);
    expect((result.req as Request & { deviceId?: string }).deviceId).toBe('device-1');
  });

  it('returns 503 when certificate lookup throws', async () => {
    const { pem } = buildTestCertPem('PROOF_device-1');
    const result = await runMiddleware(
      { 'x-forwarded-client-cert': pem },
      jest.fn().mockRejectedValue(new Error('mongo timeout'))
    );
    expect(result.statusCode).toBe(503);
    expect((result.body as { code: string }).code).toBe('CERT_LOOKUP_UNAVAILABLE');
  });
});
