import type { IFirmwareRelease } from '../models/FirmwareRelease';

export function getReleaseObjectKey(release: Pick<IFirmwareRelease, 'objectKey' | 's3Key'>): string {
  return release.objectKey || release.s3Key || '';
}
