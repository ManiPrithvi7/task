import type { OtaConfig } from '../config';
import type { IFirmwareStorage } from '../services/firmwareStorageService';
import type { IFirmwareRelease } from '../models/FirmwareRelease';
import { getReleaseObjectKey } from './firmwareReleaseKey';

/** True when URL points at Oracle Object Storage (PAR or direct). */
export function isOciFirmwareDownloadUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host.includes('objectstorage') ||
      host.includes('oci.customer-oci.com') ||
      host.endsWith('.oraclecloud.com')
    );
  } catch {
    return false;
  }
}

/** LAN dev HTTP URLs — must never be published by production OTA. */
export function isLocalLanDownloadUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:') return false;
    if (parsed.port === '8765') return true;
    return /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(parsed.hostname);
  } catch {
    return false;
  }
}

export async function buildOtaDownloadUrl(
  release: Pick<IFirmwareRelease, 'version' | 'objectKey' | 's3Key'>,
  otaConfig: OtaConfig,
  storage: IFirmwareStorage,
  publicBaseUrl: string
): Promise<string> {
  if (otaConfig.downloadMode === 'proxy') {
    const base = publicBaseUrl.replace(/\/+$/, '');
    return `${base}/api/v1/ota/download/${encodeURIComponent(release.version)}`;
  }

  const url = await storage.createPresignedGetUrl(getReleaseObjectKey(release), release.version);
  if (!isOciFirmwareDownloadUrl(url)) {
    throw new Error(
      `OCI presigned URL generation failed — got non-OCI host (check OCI credentials and bucket ${otaConfig.oci.bucket})`
    );
  }
  return url;
}
