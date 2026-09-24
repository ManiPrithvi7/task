const mockLogEvent = jest.fn().mockResolvedValue(undefined);
const mockGetAuditService = jest.fn();

jest.mock('@/services/auditService', () => ({
  AuditEventType: { OTA_SIGNING_KEY_LOADED: 'OTA_SIGNING_KEY_LOADED' },
  getAuditService: () => mockGetAuditService()
}));

import { initOtaSigningKeyAudit } from '@/services/otaService';

const VALID_SIGNING_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAR5TPk29aGcfmwOnUhgDi0cm14fPExUM2R5tMbXfw+jg=
-----END PUBLIC KEY-----`;
const VALID_KEY_FINGERPRINT = '5b138628120cf118';

const auditStub = { logEvent: mockLogEvent };

describe('initOtaSigningKeyAudit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuditService.mockReturnValue(auditStub);
  });

  it('logs key fingerprint on success', () => {
    initOtaSigningKeyAudit(VALID_SIGNING_KEY_PEM, 'env');
    expect(mockLogEvent).toHaveBeenCalledWith({
      event: 'OTA_SIGNING_KEY_LOADED',
      details: { keyFingerprint: VALID_KEY_FINGERPRINT, source: 'env' }
    });
  });

  it('logs source file variant', () => {
    initOtaSigningKeyAudit(VALID_SIGNING_KEY_PEM, 'file');
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ details: { keyFingerprint: VALID_KEY_FINGERPRINT, source: 'file' } })
    );
  });

  it('logs error details when fingerprint computation throws', () => {
    initOtaSigningKeyAudit('not-a-pem', 'env');
    expect(mockLogEvent).toHaveBeenCalledWith({
      event: 'OTA_SIGNING_KEY_LOADED',
      details: { source: 'env', error: expect.any(String) }
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
