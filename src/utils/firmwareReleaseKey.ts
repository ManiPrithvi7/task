import type { IFirmwareRelease } from '../models/FirmwareRelease';

/** Canonical object key; falls back to legacy s3Key field. */
export function getReleaseObjectKey(release: Pick<IFirmwareRelease, 'objectKey' | 's3Key'>): string {
  return release.objectKey?.trim() || release.s3Key?.trim() || '';
}
