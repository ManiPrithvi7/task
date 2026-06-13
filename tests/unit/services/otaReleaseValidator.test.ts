import {
  FinalizeValidationError,
  assertValidSha256Hex,
  assertValidVersionFormat,
  OTA_MAX_FIRMWARE_BYTES
} from '@/services/otaReleaseValidator';

describe('otaReleaseValidator', () => {
  it('accepts valid version format', () => {
    expect(() => assertValidVersionFormat('4.3.1-mvp')).not.toThrow();
    expect(() => assertValidVersionFormat('4.3.1')).not.toThrow();
  });

  it('rejects invalid version format', () => {
    expect(() => assertValidVersionFormat('bad')).toThrow(FinalizeValidationError);
  });

  it('accepts valid sha256 hex', () => {
    expect(() => assertValidSha256Hex('a'.repeat(64))).not.toThrow();
  });

  it('rejects invalid sha256', () => {
    expect(() => assertValidSha256Hex('not-hex')).toThrow(FinalizeValidationError);
  });

  it('exports firmware size cap', () => {
    expect(OTA_MAX_FIRMWARE_BYTES).toBe(2 * 1024 * 1024);
  });
});
