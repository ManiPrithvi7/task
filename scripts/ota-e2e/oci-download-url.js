/**
 * Create an OCI Object Storage download PAR for firmware artifacts.
 * Uses the same bucket/namespace/region as src/config/otaDefaults.ts.
 */

const { common, objectstorage } = require('oci-sdk');

const OTA_OCI_NAMESPACE = process.env.OTA_OCI_NAMESPACE || 'ax4egmknthnr';
const OTA_OCI_BUCKET = process.env.OTA_OCI_BUCKET || 'proof-firmware-ota';
const OTA_OCI_REGION = process.env.OTA_OCI_REGION || 'ap-hyderabad-1';
const OTA_PRESIGNED_TTL_SEC = Number(process.env.OTA_PRESIGNED_TTL_SEC || 900);

function normalizePem(raw) {
  return raw.trim().replace(/\\n/g, '\n');
}

function privateKeyFromEnv() {
  const inline = process.env.OCI_API_PRIVATE_KEY?.trim();
  if (inline) return normalizePem(inline);

  const b64 = process.env.OCI_API_PRIVATE_KEY_BASE64?.trim();
  if (b64) {
    return normalizePem(Buffer.from(b64, 'base64').toString('utf8'));
  }

  const legacy = process.env.OCI_PRIVATE_KEY?.trim();
  if (legacy) return normalizePem(legacy);

  return undefined;
}

function hasOciEnvCredentials() {
  return !!(
    process.env.OCI_TENANCY_OCID?.trim() &&
    process.env.OCI_USER_OCID?.trim() &&
    process.env.OCI_FINGERPRINT?.trim() &&
    privateKeyFromEnv()
  );
}

function parBaseUrl() {
  const override = process.env.OTA_OCI_PAR_BASE_URL?.trim().replace(/\/+$/, '');
  if (override) return override;
  return `https://${OTA_OCI_NAMESPACE}.objectstorage.${OTA_OCI_REGION}.oci.customer-oci.com`;
}

function buildParUrl(par) {
  const base = parBaseUrl();
  if (par.fullPath) {
    if (par.fullPath.startsWith('http://') || par.fullPath.startsWith('https://')) {
      return par.fullPath;
    }
    return `${base}${par.fullPath.startsWith('/') ? '' : '/'}${par.fullPath}`;
  }
  const uri = par.accessUri.startsWith('/') ? par.accessUri : `/${par.accessUri}`;
  return `${base}${uri}`;
}

function buildObjectKey(version) {
  if (process.env.OTA_OBJECT_KEY?.trim()) {
    return process.env.OTA_OBJECT_KEY.trim();
  }
  const safe = version.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `firmware/${safe}/firmware.bin`;
}

function createOciClient() {
  const provider = new common.SimpleAuthenticationDetailsProvider(
    process.env.OCI_TENANCY_OCID.trim(),
    process.env.OCI_USER_OCID.trim(),
    process.env.OCI_FINGERPRINT.trim(),
    privateKeyFromEnv(),
    null,
    common.Region.fromRegionId(OTA_OCI_REGION)
  );

  const client = new objectstorage.ObjectStorageClient({
    authenticationDetailsProvider: provider
  });
  client.regionId = OTA_OCI_REGION;
  return client;
}

async function createOciDownloadUrl(version) {
  if (!hasOciEnvCredentials()) {
    throw new Error(
      'OCI credentials missing — set OCI_TENANCY_OCID, OCI_USER_OCID, OCI_FINGERPRINT, OCI_API_PRIVATE_KEY_BASE64 in proofmqtt/.env'
    );
  }

  const objectKey = buildObjectKey(version);
  const client = createOciClient();
  const expires = new Date(Date.now() + OTA_PRESIGNED_TTL_SEC * 1000);

  const response = await client.createPreauthenticatedRequest({
    namespaceName: OTA_OCI_NAMESPACE,
    bucketName: OTA_OCI_BUCKET,
    createPreauthenticatedRequestDetails: {
      name: `ota-e2e-download-${Date.now()}`.slice(0, 200),
      objectName: objectKey,
      accessType: objectstorage.models.CreatePreauthenticatedRequestDetails.AccessType.ObjectRead,
      timeExpires: expires
    }
  });

  const downloadUrl = buildParUrl(response.preauthenticatedRequest);
  return { downloadUrl, objectKey, expiresAt: expires.toISOString() };
}

module.exports = {
  OTA_OCI_BUCKET,
  OTA_OCI_NAMESPACE,
  OTA_OCI_REGION,
  buildObjectKey,
  createOciDownloadUrl,
  hasOciEnvCredentials
};
