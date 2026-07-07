import { computeSigningKeyFingerprint } from './otaService';
import { AuditEventType, getAuditService } from './auditService';

export function initOtaSigningKeyAudit(publicKeyPem: string, source: 'env' | 'file'): void {
  try {
    const fingerprint = computeSigningKeyFingerprint(publicKeyPem);
    void getAuditService()
      ?.logEvent({
        event: AuditEventType.OTA_SIGNING_KEY_LOADED,
        details: { keyFingerprint: fingerprint, source }
      })
      .catch(() => undefined);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    void getAuditService()
      ?.logEvent({
        event: AuditEventType.OTA_SIGNING_KEY_LOADED,
        details: { source, error: msg }
      })
      .catch(() => undefined);
  }
}
