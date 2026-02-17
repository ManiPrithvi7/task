/**
 * Certificate Validator Utilities
 * 
 * PKI Improvement #4: Runtime KU/EKU enforcement at every device authentication.
 * 
 * Validates that device certificates contain required Key Usage (KU) and
 * Extended Key Usage (EKU) extensions, and rejects prohibited capabilities.
 * 
 * Required at every ensureDeviceProvisioned() call — not just at issuance.
 */

import * as forge from 'node-forge';
import { logger } from './logger';

export interface KuEkuValidationResult {
  valid: boolean;
  hasDigitalSignature: boolean;
  hasClientAuth: boolean;
  hasProhibitedKeyCertSign: boolean;
  errors: string[];
}

/**
 * Validate Key Usage (KU) and Extended Key Usage (EKU) on a certificate.
 * 
 * Rules:
 * - MUST have digitalSignature KU
 * - MUST have clientAuth EKU
 * - MUST NOT have keyCertSign KU (only CA certs should have this)
 * 
 * @param certPem PEM-encoded certificate string
 * @returns Validation result with detailed status
 */
export function validateKeyUsageAndEKU(certPem: string): KuEkuValidationResult {
  const result: KuEkuValidationResult = {
    valid: true,
    hasDigitalSignature: false,
    hasClientAuth: false,
    hasProhibitedKeyCertSign: false,
    errors: []
  };

  try {
    const cert = forge.pki.certificateFromPem(certPem);
    const extensions = cert.extensions || [];

    // Check Key Usage extension
    const kuExt = extensions.find((ext: any) => ext.name === 'keyUsage');
    if (kuExt) {
      result.hasDigitalSignature = !!(kuExt as any).digitalSignature;
      result.hasProhibitedKeyCertSign = !!(kuExt as any).keyCertSign;

      if (!result.hasDigitalSignature) {
        result.valid = false;
        result.errors.push('Certificate missing required digitalSignature KeyUsage');
      }

      if (result.hasProhibitedKeyCertSign) {
        result.valid = false;
        result.errors.push('Certificate contains prohibited keyCertSign capability (only CA certs should have this)');
      }
    } else {
      // No KU extension at all — legacy certificate, fail validation
      result.valid = false;
      result.errors.push('Certificate missing KeyUsage extension entirely (legacy certificate)');
    }

    // Check Extended Key Usage extension
    const ekuExt = extensions.find((ext: any) => ext.name === 'extKeyUsage');
    if (ekuExt) {
      result.hasClientAuth = !!(ekuExt as any).clientAuth;

      if (!result.hasClientAuth) {
        result.valid = false;
        result.errors.push('Certificate missing required clientAuth ExtendedKeyUsage');
      }
    } else {
      // No EKU extension at all — legacy certificate, fail validation
      result.valid = false;
      result.errors.push('Certificate missing ExtendedKeyUsage extension entirely (legacy certificate)');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    result.valid = false;
    result.errors.push(`Failed to parse certificate for KU/EKU validation: ${msg}`);
    logger.error('certValidator: failed to parse certificate', { error: msg });
  }

  return result;
}

/**
 * Quick check: does the certificate have valid KU/EKU for device authentication?
 * Returns true if all checks pass, false otherwise.
 */
export function hasValidKeyUsage(certPem: string): boolean {
  return validateKeyUsageAndEKU(certPem).valid;
}

/**
 * Get human-readable certificate info for logging.
 */
export function getCertificateInfo(certPem: string): {
  cn?: string;
  serialNumber?: string;
  notBefore?: string;
  notAfter?: string;
  issuerCN?: string;
  daysUntilExpiry?: number;
} {
  try {
    const cert = forge.pki.certificateFromPem(certPem);
    const cnAttr = cert.subject.getField('CN');
    const issuerCN = cert.issuer.getField('CN');
    const now = new Date();
    const notAfter = cert.validity.notAfter;
    const daysUntilExpiry = Math.floor((notAfter.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    return {
      cn: cnAttr?.value || undefined,
      serialNumber: cert.serialNumber,
      notBefore: cert.validity.notBefore.toISOString(),
      notAfter: notAfter.toISOString(),
      issuerCN: issuerCN?.value || undefined,
      daysUntilExpiry
    };
  } catch {
    return {};
  }
}
