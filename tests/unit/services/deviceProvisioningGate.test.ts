import { ensureDeviceProvisioned } from '@/services/deviceProvisioningGate';
import type { CAService } from '@/services/caService';

jest.mock('@/services/auditService', () => ({
  getAuditService: jest.fn().mockReturnValue(null),
  AuditEventType: {}
}));

const baseProvisioning = {
  requireMtlsForRegistration: true,
  cnPrefix: 'PROOF_',
  enforceRuntimeKuEku: false,
  chainValidationEnabled: false
};

describe('ensureDeviceProvisioned', () => {
  it('returns true when mTLS registration gate is disabled', async () => {
    const result = await ensureDeviceProvisioned('device-1', {
      provisioning: { ...baseProvisioning, requireMtlsForRegistration: false },
      caService: null
    });
    expect(result).toBe(true);
  });

  it('returns false when caService is missing but gate is enabled', async () => {
    const result = await ensureDeviceProvisioned('device-1', {
      provisioning: baseProvisioning,
      caService: null
    });
    expect(result).toBe(false);
  });

  it('returns false when no active certificate exists', async () => {
    const caService = {
      findActiveCertificateByDeviceId: jest.fn().mockResolvedValue(null),
      formatExpectedCN: jest.fn()
    } as unknown as CAService;

    const result = await ensureDeviceProvisioned('device-1', {
      provisioning: baseProvisioning,
      caService
    });
    expect(result).toBe(false);
  });

  it('returns true when active certificate CN matches', async () => {
    const caService = {
      findActiveCertificateByDeviceId: jest.fn().mockResolvedValue({
        cn: 'PROOF_device-1',
        fingerprint: 'abc123',
        slot: 'primary'
      }),
      formatExpectedCN: jest.fn().mockReturnValue('PROOF_device-1')
    } as unknown as CAService;

    const result = await ensureDeviceProvisioned('device-1', {
      provisioning: baseProvisioning,
      caService
    });
    expect(result).toBe(true);
  });

  it('returns false on CN mismatch', async () => {
    const caService = {
      findActiveCertificateByDeviceId: jest.fn().mockResolvedValue({
        cn: 'PROOF_other',
        fingerprint: 'abc123',
        slot: 'primary'
      }),
      formatExpectedCN: jest.fn().mockReturnValue('PROOF_device-1')
    } as unknown as CAService;

    const result = await ensureDeviceProvisioned('device-1', {
      provisioning: baseProvisioning,
      caService
    });
    expect(result).toBe(false);
  });
});
