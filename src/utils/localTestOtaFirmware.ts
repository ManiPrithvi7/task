/**
 * Resolve the local TEST_OTA firmware artifact under data/.
 * Prefer TEST_OTA_FIRMWARE_PATH; otherwise first *.ino.bin / *.bin in data/.
 */

import fs from 'fs';
import path from 'path';

export interface LocalTestOtaFirmware {
  filePath: string;
  filename: string;
  sizeBytes: number;
}

function isFirmwareBin(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.ino.bin') || lower.endsWith('.bin');
}

export function resolveLocalTestOtaFirmware(
  dataDir = path.resolve('data')
): LocalTestOtaFirmware | null {
  const explicit = process.env.TEST_OTA_FIRMWARE_PATH?.trim();
  if (explicit) {
    const filePath = path.resolve(explicit);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size < 1) return null;
      return { filePath, filename: path.basename(filePath), sizeBytes: stat.size };
    } catch {
      return null;
    }
  }

  try {
    const entries = fs.readdirSync(dataDir).filter(isFirmwareBin).sort();
    if (entries.length === 0) return null;
    // Prefer .ino.bin when both exist.
    const preferred =
      entries.find((n) => n.toLowerCase().endsWith('.ino.bin')) || entries[0];
    const filePath = path.join(dataDir, preferred);
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 1) return null;
    return { filePath, filename: preferred, sizeBytes: stat.size };
  } catch {
    return null;
  }
}
