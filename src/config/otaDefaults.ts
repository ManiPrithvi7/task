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
