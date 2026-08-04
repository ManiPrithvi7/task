/**
 * deviceProvisioningGate — P0 Test Suite
 *
 * P0: Audit branches (fail/success), KU/EKU enforcement, chain validation
 */

const mockLogEvent = jest.fn().mockResolvedValue(undefined);
const mockGetAuditService = jest.fn();
const mockValidateKeyUsageAndEKU = jest.fn();

jest.mock('@/services/auditService', () => ({
  getAuditService: (...args: unknown[]) => mockGetAuditService(...args),
  AuditEventType: {
    DEVICE_AUTH_FAILED: 'DEVICE_AUTH_FAILED',
    DEVICE_AUTH_SUCCESS: 'DEVICE_AUTH_SUCCESS',
    KU_EKU_VALIDATION_FAILED: 'KU_EKU_VALIDATION_FAILED',
    CHAIN_VALIDATION_FAILED: 'CHAIN_VALIDATION_FAILED',
  },
}));

jest.mock('@/utils/certValidator', () => ({
  validateKeyUsageAndEKU: (...args: unknown[]) => mockValidateKeyUsageAndEKU(...args),
}));


import { ensureDeviceProvisioned } from '@/services/deviceProvisioningGate';
import { CertLookupUnavailableError, type CAService } from '@/services/caService';
import * as chainValidator from '@/services/chainValidator';

const baseProvisioning = {
  requireMtlsForRegistration: true,
  cnPrefix: 'PROOF_',
  enforceRuntimeKuEku: false,
  chainValidationEnabled: false,
};

function makeCaService(overrides: Partial<CAService> = {}): CAService {
  return {
    findActiveCertificateByDeviceId: jest.fn().mockResolvedValue(null),
    formatExpectedCN: jest.fn(),
    getRootCACertificate: jest.fn().mockReturnValue('root-ca-pem'),
    ...overrides,
  } as unknown as CAService;
}

function matchingCert(overrides: Record<string, unknown> = {}) {
  return {
    cn: 'PROOF_device-1',
    fingerprint: 'abc123',
    slot: 'primary',
    expires_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('ensureDeviceProvisioned', () => {
  let validateChainSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuditService.mockReturnValue({ logEvent: mockLogEvent });
    mockValidateKeyUsageAndEKU.mockReturnValue({
      valid: true,
      errors: [],
      hasDigitalSignature: true,
      hasClientAuth: true,
      hasProhibitedKeyCertSign: false,
    });
    validateChainSpy = jest.spyOn(chainValidator, 'validateCertificateChain').mockReturnValue({
      valid: true,
      errors: [],
      chainLength: 2,
      chainSubjects: ['device', 'ca'],
    });
  });

  afterEach(() => {
    validateChainSpy.mockRestore();
  });

  /* ── Existing gate short-circuits ── */

  it('returns true when mTLS registration gate is disabled', async () => {
    const result = await ensureDeviceProvisioned('device-1', {
      provisioning: { ...baseProvisioning, requireMtlsForRegistration: false },
      caService: null,
    });
    expect(result).toBe(true);
  });

  it('returns false when caService is missing but gate is enabled', async () => {
    const result = await ensureDeviceProvisioned('device-1', {
      provisioning: baseProvisioning,
      caService: null,
    });
    expect(result).toBe(false);
  });

  it('returns false when no active certificate exists', async () => {
    const caService = makeCaService({
      findActiveCertificateByDeviceId: jest.fn().mockResolvedValue(null),
    });

    const result = await ensureDeviceProvisioned('device-1', {
      provisioning: baseProvisioning,
      caService,
    });
    expect(result).toBe(false);
  });

  it('returns true when active certificate CN matches', async () => {
    const caService = makeCaService({
      findActiveCertificateByDeviceId: jest.fn().mockResolvedValue(matchingCert()),
      formatExpectedCN: jest.fn().mockReturnValue('PROOF_device-1'),
    });

    const result = await ensureDeviceProvisioned('device-1', {
      provisioning: baseProvisioning,
      caService,
    });
    expect(result).toBe(true);
  });

  it('returns false on CN mismatch', async () => {
    const caService = makeCaService({
      findActiveCertificateByDeviceId: jest.fn().mockResolvedValue(
        matchingCert({ cn: 'PROOF_other' })
      ),
      formatExpectedCN: jest.fn().mockReturnValue('PROOF_device-1'),
    });

    const result = await ensureDeviceProvisioned('device-1', {
      provisioning: baseProvisioning,
      caService,
    });
    expect(result).toBe(false);
  });

  it('throws CertLookupUnavailableError when CA lookup fails', async () => {
    const caService = makeCaService({
      findActiveCertificateByDeviceId: jest
        .fn()
        .mockRejectedValue(new CertLookupUnavailableError('db down')),
    });

    await expect(
      ensureDeviceProvisioned('device-1', {
        provisioning: baseProvisioning,
        caService,
      })
    ).rejects.toThrow(CertLookupUnavailableError);
  });

  /* ══════════════════════════════════════════════════════════════
   * P0: Audit branches
   * ══════════════════════════════════════════════════════════════ */

  describe('audit logging', () => {
    it('logs DEVICE_AUTH_FAILED when no active certificate', async () => {
      const caService = makeCaService({
        findActiveCertificateByDeviceId: jest.fn().mockResolvedValue(null),
      });

      await ensureDeviceProvisioned('device-1', { provisioning: baseProvisioning, caService });

      expect(mockLogEvent).toHaveBeenCalledWith({
        event: 'DEVICE_AUTH_FAILED',
        deviceId: 'device-1',
        details: { reason: 'NO_ACTIVE_CERTIFICATE' },
      });
    });

    it('logs DEVICE_AUTH_FAILED on CN mismatch with fingerprint and CN details', async () => {
      const caService = makeCaService({
        findActiveCertificateByDeviceId: jest.fn().mockResolvedValue(
          matchingCert({ cn: 'PROOF_other' })
        ),
        formatExpectedCN: jest.fn().mockReturnValue('PROOF_device-1'),
      });

      await ensureDeviceProvisioned('device-1', { provisioning: baseProvisioning, caService });

      expect(mockLogEvent).toHaveBeenCalledWith({
        event: 'DEVICE_AUTH_FAILED',
        deviceId: 'device-1',
        certificateFingerprint: 'abc123',
        details: {
          reason: 'CN_MISMATCH',
          expectedCN: 'PROOF_device-1',
          certCN: 'PROOF_other',
        },
      });
    });

    it('logs DEVICE_AUTH_SUCCESS with slot, cn, and ISO expiresAt', async () => {
      const expiresAt = new Date('2026-06-15T12:00:00.000Z');
      const caService = makeCaService({
        findActiveCertificateByDeviceId: jest.fn().mockResolvedValue(
          matchingCert({ expires_at: expiresAt, slot: 'staging' })
        ),
        formatExpectedCN: jest.fn().mockReturnValue('PROOF_device-1'),
      });

      const result = await ensureDeviceProvisioned('device-1', {
        provisioning: baseProvisioning,
        caService,
      });

      expect(result).toBe(true);
      expect(mockLogEvent).toHaveBeenCalledWith({
        event: 'DEVICE_AUTH_SUCCESS',
        deviceId: 'device-1',
        certificateFingerprint: 'abc123',
        details: {
          slot: 'staging',
          cn: 'PROOF_device-1',
          expiresAt: expiresAt.toISOString(),
        },
      });
    });

    it('defaults certSlot to primary in success audit when slot is undefined', async () => {
      const caService = makeCaService({
        findActiveCertificateByDeviceId: jest.fn().mockResolvedValue(
          matchingCert({ slot: undefined })
        ),
        formatExpectedCN: jest.fn().mockReturnValue('PROOF_device-1'),
      });

      await ensureDeviceProvisioned('device-1', { provisioning: baseProvisioning, caService });

      expect(mockLogEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'DEVICE_AUTH_SUCCESS',
          details: expect.objectContaining({ slot: 'primary' }),
        })
      );
    });

    it('swallows audit logEvent rejection without failing the gate', async () => {
      mockLogEvent.mockRejectedValueOnce(new Error('audit down'));
      const caService = makeCaService({
        findActiveCertificateByDeviceId: jest.fn().mockResolvedValue(matchingCert()),
        formatExpectedCN: jest.fn().mockReturnValue('PROOF_device-1'),
      });

      const result = await ensureDeviceProvisioned('device-1', {
        provisioning: baseProvisioning,
        caService,
      });

      expect(result).toBe(true);
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P0: KU/EKU enforcement
   * ══════════════════════════════════════════════════════════════ */

  describe('KU/EKU enforcement', () => {
    const kuProvisioning = { ...baseProvisioning, enforceRuntimeKuEku: true };

    function certWithPem(overrides: Record<string, unknown> = {}) {
      return matchingCert({ certificate: 'device-cert-pem', ...overrides });
    }

    it('rejects invalid KU/EKU and logs KU_EKU_VALIDATION_FAILED audit', async () => {
      mockValidateKeyUsageAndEKU.mockReturnValue({
        valid: false,
        errors: ['digitalSignature missing', 'clientAuth missing'],
        hasDigitalSignature: false,
        hasClientAuth: false,
        hasProhibitedKeyCertSign: false,
      });

      const caService = makeCaService({
        findActiveCertificateByDeviceId: jest.fn().mockResolvedValue(certWithPem()),
        formatExpectedCN: jest.fn().mockReturnValue('PROOF_device-1'),
      });

      const result = await ensureDeviceProvisioned('device-1', {
        provisioning: kuProvisioning,
        caService,
      });

      expect(result).toBe(false);
      expect(mockValidateKeyUsageAndEKU).toHaveBeenCalledWith('device-cert-pem');
      expect(mockLogEvent).toHaveBeenCalledWith({
        event: 'KU_EKU_VALIDATION_FAILED',
        deviceId: 'device-1',
        certificateFingerprint: 'abc123',
        details: {
          reason: 'KU_EKU_INVALID',
          errors: ['digitalSignature missing', 'clientAuth missing'],
          missingExtensions: ['digitalSignature missing', 'clientAuth missing'],
          hasDigitalSignature: false,
          hasClientAuth: false,
          hasProhibitedKeyCertSign: false,
          slot: 'primary',
        },
      });
    });

    it('proceeds to success when KU/EKU is valid', async () => {
      const caService = makeCaService({
        findActiveCertificateByDeviceId: jest.fn().mockResolvedValue(certWithPem()),
        formatExpectedCN: jest.fn().mockReturnValue('PROOF_device-1'),
      });

      const result = await ensureDeviceProvisioned('device-1', {
        provisioning: kuProvisioning,
        caService,
      });

      expect(result).toBe(true);
      expect(mockValidateKeyUsageAndEKU).toHaveBeenCalledWith('device-cert-pem');
      expect(mockLogEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'DEVICE_AUTH_SUCCESS' })
      );
    });

    it('skips KU/EKU check when cert.certificate is falsy', async () => {
      const caService = makeCaService({
        findActiveCertificateByDeviceId: jest.fn().mockResolvedValue(
          matchingCert({ certificate: undefined })
        ),
        formatExpectedCN: jest.fn().mockReturnValue('PROOF_device-1'),
      });

      const result = await ensureDeviceProvisioned('device-1', {
        provisioning: kuProvisioning,
        caService,
      });

      expect(result).toBe(true);
      expect(mockValidateKeyUsageAndEKU).not.toHaveBeenCalled();
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P0: Chain validation
   * ══════════════════════════════════════════════════════════════ */

  describe('chain validation', () => {
    const chainProvisioning = { ...baseProvisioning, chainValidationEnabled: true };

    function certWithChain(overrides: Record<string, unknown> = {}) {
      return matchingCert({
        certificate: 'device-cert-pem',
        ca_certificate: 'intermediate-pem',
        ...overrides,
      });
    }

    it('rejects invalid chain and logs CHAIN_VALIDATION_FAILED audit', async () => {
      validateChainSpy.mockReturnValue({
        valid: false,
        errors: ['root not trusted', 'expired intermediate'],
        chainSubjects: ['device', 'intermediate'],
      });

      const caService = makeCaService({
        findActiveCertificateByDeviceId: jest.fn().mockResolvedValue(certWithChain()),
        formatExpectedCN: jest.fn().mockReturnValue('PROOF_device-1'),
      });

      const result = await ensureDeviceProvisioned('device-1', {
        provisioning: chainProvisioning,
        caService,
      });

      expect(result).toBe(false);
      expect(validateChainSpy).toHaveBeenCalledWith(
        'device-cert-pem',
        [],
        'root-ca-pem'
      );
      expect(mockLogEvent).toHaveBeenCalledWith({
        event: 'CHAIN_VALIDATION_FAILED',
        deviceId: 'device-1',
        certificateFingerprint: 'abc123',
        details: {
          reason: 'CHAIN_INVALID',
          failurePoint: 'root not trusted',
          errors: ['root not trusted', 'expired intermediate'],
          chainSubjects: ['device', 'intermediate'],
          slot: 'primary',
        },
      });
    });

    it('proceeds to success when chain is valid', async () => {
      const caService = makeCaService({
        findActiveCertificateByDeviceId: jest.fn().mockResolvedValue(certWithChain()),
        formatExpectedCN: jest.fn().mockReturnValue('PROOF_device-1'),
      });

      const result = await ensureDeviceProvisioned('device-1', {
        provisioning: chainProvisioning,
        caService,
      });

      expect(result).toBe(true);
      expect(mockLogEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'DEVICE_AUTH_SUCCESS' })
      );
    });

    it('rejects when validateCertificateChain throws and logs CHAIN_VALIDATION_ERROR', async () => {
      validateChainSpy.mockImplementation(() => {
        throw new Error('parse failure');
      });

      const caService = makeCaService({
        findActiveCertificateByDeviceId: jest.fn().mockResolvedValue(certWithChain()),
        formatExpectedCN: jest.fn().mockReturnValue('PROOF_device-1'),
      });

      const result = await ensureDeviceProvisioned('device-1', {
        provisioning: chainProvisioning,
        caService,
      });

      expect(result).toBe(false);
      expect(mockLogEvent).toHaveBeenCalledWith({
        event: 'CHAIN_VALIDATION_FAILED',
        deviceId: 'device-1',
        certificateFingerprint: 'abc123',
        details: {
          reason: 'CHAIN_VALIDATION_ERROR',
          failurePoint: 'parse failure',
          slot: 'primary',
        },
      });
    });

    it('skips chain validation when ca_certificate is missing', async () => {
      const caService = makeCaService({
        findActiveCertificateByDeviceId: jest.fn().mockResolvedValue(
          certWithChain({ ca_certificate: undefined })
        ),
        formatExpectedCN: jest.fn().mockReturnValue('PROOF_device-1'),
      });

      const result = await ensureDeviceProvisioned('device-1', {
        provisioning: chainProvisioning,
        caService,
      });

      expect(result).toBe(true);
      expect(validateChainSpy).not.toHaveBeenCalled();
    });
  });
});
