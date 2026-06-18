/**
 * Fixed Proof.io OTA / OCI Object Storage settings (non-secret).
 * Override only when pointing at a different tenancy or bucket.
 */

export const OTA_OCI_NAMESPACE = 'ax4egmknthnr';
export const OTA_OCI_BUCKET = 'proof-firmware-ota';
export const OTA_OCI_REGION = 'ap-hyderabad-1';

/** PAR download host for this tenancy (devices receive PAR URLs built from this). */
export function otaOciParBaseUrl(namespace = OTA_OCI_NAMESPACE, region = OTA_OCI_REGION): string {
  return `https://${namespace}.objectstorage.${region}.oci.customer-oci.com`;
}

export const OTA_PRESIGNED_TTL_SEC = 900;
export const OTA_CHECK_RATE_LIMIT_SEC = 300;
export const OTA_ROLLBACK_FAILURE_THRESHOLD = 3;

export type OtaDownloadMode = 'presigned' | 'proxy';

/**
 * HTTP download route mode only — MQTT ota_update always carries OCI presigned PAR.
 * Default: presigned (production / Railway).
 * proxy: enable GET /api/v1/ota/download/:version (requires mTLS-capable HTTP edge).
 */
export function resolveOtaDownloadMode(envValue?: string): OtaDownloadMode {
  return envValue?.trim() === 'proxy' ? 'proxy' : 'presigned';
}

/** Public base URL for OTA proxy download links (never LAN / request host). */
export function resolveOtaPublicBaseUrl(options: {
  otaPublicBaseUrl?: string;
  publicAppUrl?: string;
  httpHost?: string;
  httpPort?: number;
}): string {
  const explicit = options.otaPublicBaseUrl?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const appUrl = options.publicAppUrl?.trim();
  if (appUrl) return appUrl.replace(/\/+$/, '');

  const host = options.httpHost === '0.0.0.0' ? 'localhost' : options.httpHost || 'localhost';
  const port = options.httpPort ?? 3002;
  return `http://${host}:${port}`;
}

export function buildOtaProxyDownloadUrl(publicBaseUrl: string, version: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}/api/v1/ota/download/${encodeURIComponent(version)}`;
}
