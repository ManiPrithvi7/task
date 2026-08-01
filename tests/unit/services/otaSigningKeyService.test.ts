import { initOtaSigningKeyAudit } from '@/services/otaSigningKeyService';

const mockComputeFingerprint = jest.fn();
const mockLogEvent = jest.fn().mockResolvedValue(undefined);
const mockGetAuditService = jest.fn();

jest.mock('@/services/otaService', () => ({
  computeSigningKeyFingerprint: (...args: unknown[]) => mockComputeFingerprint(...args)
}));

jest.mock('@/services/auditService', () => ({
  AuditEventType: { OTA_SIGNING_KEY_LOADED: 'OTA_SIGNING_KEY_LOADED' },
  getAuditService: () => mockGetAuditService()
}));

const auditStub = { logEvent: mockLogEvent };

describe('initOtaSigningKeyAudit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuditService.mockReturnValue(auditStub);
  });

  it('logs key fingerprint on success', () => {
    mockComputeFingerprint.mockReturnValue('SHA256:abc123');
    initOtaSigningKeyAudit('-----BEGIN PUBLIC KEY-----', 'env');
    expect(mockLogEvent).toHaveBeenCalledWith({
      event: 'OTA_SIGNING_KEY_LOADED',
      details: { keyFingerprint: 'SHA256:abc123', source: 'env' }
    });
  });

  it('logs source file variant', () => {
    mockComputeFingerprint.mockReturnValue('SHA256:xyz');
    initOtaSigningKeyAudit('pem', 'file');
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ details: { keyFingerprint: 'SHA256:xyz', source: 'file' } })
    );
  });

  it('logs error details when fingerprint computation throws', () => {
    mockComputeFingerprint.mockImplementation(() => {
      throw new Error('bad pem');
    });
    initOtaSigningKeyAudit('pem', 'env');
    expect(mockLogEvent).toHaveBeenCalledWith({
      event: 'OTA_SIGNING_KEY_LOADED',
      details: { source: 'env', error: 'bad pem' }
    });
  });

  it('tolerates missing audit service (no throw)', () => {
    mockGetAuditService.mockReturnValue(undefined);
    expect(() => initOtaSigningKeyAudit('pem', 'env')).not.toThrow();
  });

  it('swallows logEvent rejection', () => {
    mockLogEvent.mockReturnValue(Promise.reject(new Error('influx down')));
    initOtaSigningKeyAudit('pem', 'env');
    expect(mockLogEvent).toHaveBeenCalled();
  });
});
