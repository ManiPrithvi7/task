import type { ProvisioningConfig } from '../config';
import type { CAService } from './caService';
import { CertLookupUnavailableError } from './caService';
import { getAuditService, AuditEventType } from './auditService';
import { validateCertificateChain } from './chainValidator';
import { validateKeyUsageAndEKU } from '../utils/certValidator';
import { logger } from '../utils/logger';

export interface DeviceProvisioningGateDeps {
  provisioning: Pick<
    ProvisioningConfig,
    'requireMtlsForRegistration' | 'cnPrefix' | 'enforceRuntimeKuEku' | 'chainValidationEnabled'
  >;
  caService: CAService | null | undefined;
}

/**
 * Validates that the device is allowed for mTLS-aligned registration (has active provisioned certificate).
 * Enforces CN match, optional KU/EKU, and chain validation when enabled in config.
 * Returns false for unprovisioned/invalid; throws CertLookupUnavailableError on DB blips.
 */
export async function ensureDeviceProvisioned(
  deviceId: string,
  deps: DeviceProvisioningGateDeps
): Promise<boolean> {
  if (!deps.provisioning.requireMtlsForRegistration) {
    return true;
  }
  if (!deps.caService) {
    logger.error('Registration rejected: requireMtlsForRegistration is enabled but PKI (caService) is not wired', {
      deviceId
    });
    return false;
  }

  const caService = deps.caService;

  let cert;
  try {
    cert = await caService.findActiveCertificateByDeviceId(deviceId, {
      slots: ['primary', 'staging']
    });
  } catch (err: unknown) {
    if (err instanceof CertLookupUnavailableError) {
      logger.error('Registration deferred: certificate lookup unavailable', { deviceId });
      throw err;
    }
    throw err;
  }
  if (!cert) {
    const auditSvc = getAuditService();
    if (auditSvc) {
      await auditSvc
        .logEvent({
          event: AuditEventType.DEVICE_AUTH_FAILED,
          deviceId,
          details: { reason: 'NO_ACTIVE_CERTIFICATE' }
        })
        .catch(() => undefined);
    }
    return false;
  }

  const certSlot = cert.slot ?? 'primary';

  let expectedCN: string;
  try {
    expectedCN = caService.formatExpectedCN(deviceId);
  } catch {
    const prefix = deps.provisioning.cnPrefix || process.env.CERT_CN_PREFIX || 'PROOF';
    expectedCN = `${String(prefix).trim()}-${deviceId}`;
  }

  if (cert.cn !== expectedCN) {
    logger.warn('Certificate CN mismatch for device - provisioning rejected', {
      deviceId,
      expectedCN,
      certCN: cert.cn
    });
    const auditSvc = getAuditService();
    if (auditSvc) {
      await auditSvc
        .logEvent({
          event: AuditEventType.DEVICE_AUTH_FAILED,
          deviceId,
          certificateFingerprint: cert.fingerprint,
          details: { reason: 'CN_MISMATCH', expectedCN, certCN: cert.cn }
        })
        .catch(() => undefined);
    }
    return false;
  }

  if (deps.provisioning.enforceRuntimeKuEku && cert.certificate) {
    const kuResult = validateKeyUsageAndEKU(cert.certificate);
    if (!kuResult.valid) {
      logger.warn('[PKI:KU_EKU] Certificate validation failed — rejecting', {
        deviceId,
        errors: kuResult.errors
      });
      const auditSvc = getAuditService();
      if (auditSvc) {
        await auditSvc
          .logEvent({
            event: AuditEventType.KU_EKU_VALIDATION_FAILED,
            deviceId,
            certificateFingerprint: cert.fingerprint,
            details: {
              reason: 'KU_EKU_INVALID',
              errors: kuResult.errors,
              missingExtensions: kuResult.errors.filter((e) => e.includes('missing')),
              hasDigitalSignature: kuResult.hasDigitalSignature,
              hasClientAuth: kuResult.hasClientAuth,
              hasProhibitedKeyCertSign: kuResult.hasProhibitedKeyCertSign,
              slot: certSlot
            }
          })
          .catch(() => undefined);
      }
      return false;
    }
  }

  if (deps.provisioning.chainValidationEnabled && cert.certificate && cert.ca_certificate) {
    try {
      const rootCAPem = caService.getRootCACertificate();
      const chainResult = validateCertificateChain(cert.certificate, [], rootCAPem);
      if (!chainResult.valid) {
        logger.warn('[PKI:CHAIN] Certificate chain validation failed — rejecting', {
          deviceId,
          errors: chainResult.errors
        });
        const auditSvc = getAuditService();
        if (auditSvc) {
          await auditSvc
            .logEvent({
              event: AuditEventType.CHAIN_VALIDATION_FAILED,
              deviceId,
              certificateFingerprint: cert.fingerprint,
              details: {
                reason: 'CHAIN_INVALID',
                failurePoint: chainResult.errors[0] ?? 'unknown',
                errors: chainResult.errors,
                chainSubjects: chainResult.chainSubjects,
                slot: certSlot
              }
            })
            .catch(() => undefined);
        }
        return false;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[PKI:CHAIN] Chain validation error — rejecting', {
        deviceId,
        error: msg
      });
      const auditSvc = getAuditService();
      if (auditSvc) {
        await auditSvc
          .logEvent({
            event: AuditEventType.CHAIN_VALIDATION_FAILED,
            deviceId,
            certificateFingerprint: cert.fingerprint,
            details: { reason: 'CHAIN_VALIDATION_ERROR', failurePoint: msg, slot: certSlot }
          })
          .catch(() => undefined);
      }
      return false;
    }
  }

  const auditSvc = getAuditService();
  if (auditSvc) {
    await auditSvc
      .logEvent({
        event: AuditEventType.DEVICE_AUTH_SUCCESS,
        deviceId,
        certificateFingerprint: cert.fingerprint,
        details: {
          slot: certSlot,
          cn: cert.cn,
          expiresAt: cert.expires_at?.toISOString?.() ?? String(cert.expires_at)
        }
      })
      .catch(() => undefined);
  }

  return true;
}
