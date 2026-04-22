import * as crypto from 'crypto';

export interface DeviceKeys {
  deviceId: string;
  ca: string;
  cert: string;
  key: string;
}

/**
 * Strips the CERT_CN_PREFIX (default "PROOF") from a cert CN
 * so the returned id matches the provisioning device_id stored in Mongo.
 * Mirrors CAService.formatExpectedCN() in reverse.
 * e.g. "PROOF-ADMIN-1" → "ADMIN-1"
 */
export function stripCnPrefix(cn: string): string {
  const rawPrefix = process.env.CERT_CN_PREFIX ?? 'PROOF';
  const prefix = rawPrefix.trim().replace(/[-_]+$/g, '');
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return cn.replace(new RegExp(`^${escaped}[-_]`), '');
}

/**
 * Extracts the canonical device_id from a PEM cert's CN field.
 * Returns null if the cert cannot be parsed.
 */
export function deviceIdFromCertPem(certPem: string): string | null {
  try {
    const x509 = new crypto.X509Certificate(certPem);
    // Subject may use newlines between RDNs; do not let [^,] span past the CN value
    const m = String(x509.subject).match(/CN\s*=\s*([^,\n]+)/i);
    const rawCn = m ? m[1].trim() : null;
    return rawCn ? stripCnPrefix(rawCn) : null;
  } catch {
    return null;
  }
}

