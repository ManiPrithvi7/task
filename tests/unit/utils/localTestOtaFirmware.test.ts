import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveLocalTestOtaFirmware } from '@/utils/localTestOtaFirmware';

describe('resolveLocalTestOtaFirmware', () => {
  const previousEnv = process.env.TEST_OTA_FIRMWARE_PATH;
  let tmpDir: string;

  beforeEach(() => {
    delete process.env.TEST_OTA_FIRMWARE_PATH;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-fw-'));
  });

  afterEach(() => {
    if (previousEnv === undefined) {
      delete process.env.TEST_OTA_FIRMWARE_PATH;
    } else {
      process.env.TEST_OTA_FIRMWARE_PATH = previousEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns sizeBytes from the .ino.bin in the directory', () => {
    const binPath = path.join(tmpDir, 'ESP32S3_DWIN_MVP_v101.ino.bin');
    const payload = Buffer.alloc(1213440, 1);
    fs.writeFileSync(binPath, payload);

    const resolved = resolveLocalTestOtaFirmware(tmpDir);
    expect(resolved).not.toBeNull();
    expect(resolved!.filename).toBe('ESP32S3_DWIN_MVP_v101.ino.bin');
    expect(resolved!.sizeBytes).toBe(1213440);
  });

  it('honors TEST_OTA_FIRMWARE_PATH over directory scan', () => {
    const other = path.join(tmpDir, 'other.bin');
    fs.writeFileSync(other, Buffer.alloc(100));
    const preferred = path.join(tmpDir, 'preferred.bin');
    fs.writeFileSync(preferred, Buffer.alloc(1213440));
    process.env.TEST_OTA_FIRMWARE_PATH = preferred;

    const resolved = resolveLocalTestOtaFirmware(tmpDir);
    expect(resolved!.sizeBytes).toBe(1213440);
    expect(resolved!.filename).toBe('preferred.bin');
  });
});
