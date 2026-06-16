/**
 * OCI SDK authentication — env-based API key only (production).
 * Config file fallback allowed in development only.
 */

import { common } from 'oci-sdk';
import type { OtaOciConfig } from '../config';
import { logger } from '../utils/logger';

function normalizePemFromEnv(raw: string): string {
  return raw.trim().replace(/\\n/g, '\n');
}

function privateKeyFromEnv(): string | undefined {
  const inline = process.env.OCI_API_PRIVATE_KEY?.trim();
  if (inline) return normalizePemFromEnv(inline);

  const b64 = process.env.OCI_API_PRIVATE_KEY_BASE64?.trim();
  if (b64) {
    try {
      return normalizePemFromEnv(Buffer.from(b64, 'base64').toString('utf8'));
    } catch {
      return undefined;
    }
  }

  const legacy = process.env.OCI_PRIVATE_KEY?.trim();
  if (legacy) return normalizePemFromEnv(legacy);

  return undefined;
}

export function hasOciEnvCredentials(): boolean {
  return !!(
    process.env.OCI_TENANCY_OCID?.trim() &&
    process.env.OCI_USER_OCID?.trim() &&
    process.env.OCI_FINGERPRINT?.trim() &&
    privateKeyFromEnv()
  );
}

export function createOciAuthProvider(oci: OtaOciConfig): common.AuthenticationDetailsProvider {
  const creds = oci.credentials;
  if (creds?.tenancyId && creds.userId && creds.fingerprint && creds.privateKey) {
    return new common.SimpleAuthenticationDetailsProvider(
      creds.tenancyId,
      creds.userId,
      creds.fingerprint,
      creds.privateKey,
      null,
      common.Region.fromRegionId(oci.region)
    );
  }

  const isDev = process.env.NODE_ENV !== 'production';
  const configFile = oci.configFile || process.env.OCI_CONFIG_FILE?.trim();
  const profile = oci.configProfile || process.env.OCI_CONFIG_PROFILE?.trim() || 'DEFAULT';

  if (isDev && configFile) {
    logger.warn(
      '[OTA] OCI auth via config file (development only) — set OCI_API_PRIVATE_KEY_BASE64 for production'
    );
    return new common.ConfigFileAuthenticationDetailsProvider(configFile, profile);
  }

  throw new Error(
    'OCI credentials missing: set OCI_API_PRIVATE_KEY_BASE64, OCI_TENANCY_OCID, OCI_USER_OCID, and OCI_FINGERPRINT'
  );
}
