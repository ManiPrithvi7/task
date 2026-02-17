/**
 * Certificate Chain Validator
 * 
 * PKI Improvement #2: Full RFC 5280 path validation.
 * 
 * Validates that a device certificate chains up to a trusted root through
 * any intermediate CAs. Checks:
 * - Signature chain: each cert is signed by its issuer
 * - Validity dates: all certs in chain are within their validity period
 * - Basic constraints: CA flag, pathLenConstraint
 * - (Future) Name constraints
 * 
 * Tier 1: Path validation logic (this file)
 * Tier 2: Intermediate CA generation (caService.ts)
 * Tier 3: Root CA offline/HSM (operational)
 */

import * as forge from 'node-forge';
import { logger } from '../utils/logger';

export interface ChainValidationResult {
  valid: boolean;
  chainLength: number;
  errors: string[];
  /** Subjects of each cert in the chain (leaf → root) for audit logging */
  chainSubjects: string[];
}

/**
 * Validate a certificate chain from leaf to trusted root.
 * 
 * @param leafPem Device certificate (PEM)
 * @param intermediatePems Array of intermediate CA certs (PEM), can be empty
 * @param rootPem Trusted root CA cert (PEM)
 * @returns Validation result
 */
export function validateCertificateChain(
  leafPem: string,
  intermediatePems: string[],
  rootPem: string
): ChainValidationResult {
  const result: ChainValidationResult = {
    valid: true,
    chainLength: 0,
    errors: [],
    chainSubjects: []
  };

  try {
    // Parse all certificates
    const leaf = forge.pki.certificateFromPem(leafPem);
    const intermediates = intermediatePems.map(pem => forge.pki.certificateFromPem(pem));
    const root = forge.pki.certificateFromPem(rootPem);

    // Build the chain: leaf → intermediate(s) → root
    const chain = [leaf, ...intermediates, root];
    result.chainLength = chain.length;

    // Extract subjects for audit
    result.chainSubjects = chain.map(cert => {
      const cn = cert.subject.getField('CN');
      return cn ? cn.value : 'unknown';
    });

    const now = new Date();

    // Validate each certificate in the chain
    for (let i = 0; i < chain.length; i++) {
      const cert = chain[i];
      const certCN = result.chainSubjects[i];

      // 1. Validity period check
      if (now < cert.validity.notBefore) {
        result.valid = false;
        result.errors.push(`Certificate "${certCN}" is not yet valid (notBefore: ${cert.validity.notBefore.toISOString()})`);
      }
      if (now > cert.validity.notAfter) {
        result.valid = false;
        result.errors.push(`Certificate "${certCN}" has expired (notAfter: ${cert.validity.notAfter.toISOString()})`);
      }

      // 2. Basic constraints check (non-leaf certs must be CAs)
      if (i > 0) {
        // This is an intermediate or root — must have cA: true
        const bcExt = cert.extensions?.find((ext: any) => ext.name === 'basicConstraints');
        if (!bcExt || !(bcExt as any).cA) {
          result.valid = false;
          result.errors.push(`Certificate "${certCN}" is in CA position but does not have basicConstraints.cA=true`);
        }

        // pathLenConstraint: if set, number of intermediates below this cert must not exceed it
        if (bcExt && typeof (bcExt as any).pathLenConstraint === 'number') {
          const maxIntermediatesBelow = (bcExt as any).pathLenConstraint;
          const intermediatesBelowThisCert = i - 1; // certs between leaf and this cert
          if (intermediatesBelowThisCert > maxIntermediatesBelow) {
            result.valid = false;
            result.errors.push(
              `Certificate "${certCN}" pathLenConstraint=${maxIntermediatesBelow} violated ` +
              `(${intermediatesBelowThisCert} intermediates below)`
            );
          }
        }
      }

      // 3. Leaf must NOT be a CA
      if (i === 0) {
        const bcExt = cert.extensions?.find((ext: any) => ext.name === 'basicConstraints');
        if (bcExt && (bcExt as any).cA === true) {
          result.valid = false;
          result.errors.push(`Leaf certificate "${certCN}" has basicConstraints.cA=true (should be false for device certs)`);
        }
      }

      // 4. Signature verification: verify each cert is signed by the next cert in chain
      if (i < chain.length - 1) {
        const issuer = chain[i + 1];
        try {
          const verified = issuer.verify(cert);
          if (!verified) {
            result.valid = false;
            result.errors.push(`Certificate "${certCN}" signature verification failed against issuer "${result.chainSubjects[i + 1]}"`);
          }
        } catch (verifyErr: unknown) {
          const msg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
          result.valid = false;
          result.errors.push(`Signature verification error for "${certCN}": ${msg}`);
        }
      }
    }

    // 5. Root cert must be self-signed
    try {
      const rootSelfSigned = root.verify(root);
      if (!rootSelfSigned) {
        result.valid = false;
        result.errors.push('Root CA is not self-signed');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.valid = false;
      result.errors.push(`Root CA self-signature check failed: ${msg}`);
    }

    if (result.valid) {
      logger.debug('Certificate chain validation passed', {
        chainLength: result.chainLength,
        leaf: result.chainSubjects[0],
        root: result.chainSubjects[result.chainSubjects.length - 1]
      });
    } else {
      logger.warn('Certificate chain validation FAILED', {
        chainLength: result.chainLength,
        errors: result.errors
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    result.valid = false;
    result.errors.push(`Chain validation error: ${msg}`);
    logger.error('Certificate chain validation threw an exception', { error: msg });
  }

  return result;
}

/**
 * Quick check: is the certificate chain valid?
 */
export function isChainValid(leafPem: string, intermediatePems: string[], rootPem: string): boolean {
  return validateCertificateChain(leafPem, intermediatePems, rootPem).valid;
}
