import * as fs from 'fs';
import * as path from 'path';
import type { RedisClientType } from 'redis';
import {
  assertValidSha256Hex,
  assertValidVersionFormat,
  checkOtaRateLimit,
  FinalizeValidationError,
  initOtaSigningState,
  isOtaSigningConfirmed,
  isValidObjectId,
  setOtaSigningConfirmed,
  validateFinalizeInput,
  verifyEd25519Signature
} from '@/services/otaService';
import { isVersionGreater } from '@/utils/semver';

const OTA_PUBLIC_KEY_PATH = path.join(__dirname, '../../../scripts/ota-e2e/keys/ota_public.pem');

describe('ota validation helpers', () => {
  it('accepts valid semver versions', () => {
    expect(() => assertValidVersionFormat('1.0.0')).not.toThrow();
    expect(() => assertValidVersionFormat('4.3.1-mvp')).not.toThrow();
  });

  it('rejects invalid semver versions', () => {
    expect(() => assertValidVersionFormat('v1.0.0')).toThrow(FinalizeValidationError);
    expect(() => assertValidVersionFormat('bad')).toThrow(FinalizeValidationError);
  });

  it('accepts valid sha256 hex', () => {
    expect(() =>
      assertValidSha256Hex('a'.repeat(64))
    ).not.toThrow();
  });

  it('rejects invalid sha256 hex', () => {
    expect(() => assertValidSha256Hex('abc')).toThrow(FinalizeValidationError);
  });

  it('compares versions with isVersionGreater', () => {
    expect(isVersionGreater('1.1.0', '1.0.0')).toBe(true);
    expect(isVersionGreater('1.0.0', '1.0.0')).toBe(false);
    expect(isVersionGreater('0.9.0', '1.0.0')).toBe(false);
  });
});

describe('validateFinalizeInput', () => {
  const publicKeyPem = fs.readFileSync(OTA_PUBLIC_KEY_PATH, 'utf8');

  it('throws when metadata version mismatches', () => {
    expect(() =>
      validateFinalizeInput({
        version: '1.0.0',
        sha256: 'a'.repeat(64),
        signature: 'sig',
        head: {
          sizeBytes: 1024,
          firmwareVersion: '2.0.0',
          sha256: 'a'.repeat(64)
        },
        signingPublicKeyPem: publicKeyPem
      })
    ).toThrow(FinalizeValidationError);
  });

  it('throws when signing key is missing', () => {
    expect(() =>
      validateFinalizeInput({
        version: '1.0.0',
        sha256: 'a'.repeat(64),
        signature: 'sig',
        head: {
          sizeBytes: 1024,
          firmwareVersion: '1.0.0',
          sha256: 'a'.repeat(64)
        }
      })
    ).toThrow(FinalizeValidationError);
  });
});

describe('verifyEd25519Signature', () => {
  it('returns false for malformed signature', () => {
    const publicKeyPem = fs.readFileSync(OTA_PUBLIC_KEY_PATH, 'utf8');
    expect(verifyEd25519Signature('a'.repeat(64), 'not-base64-signature!!!', publicKeyPem)).toBe(false);
  });
});

describe('checkOtaRateLimit', () => {
  it('allows request when redis client is null', async () => {
    await expect(checkOtaRateLimit(null, 'test:', 'device-1', 60)).resolves.toBe(true);
  });

  it('returns false when redis SET indicates existing key', async () => {
    const client = {
      set: jest.fn().mockResolvedValue(null)
    } as unknown as RedisClientType;

    await expect(checkOtaRateLimit(client, 'test:', 'device-1', 60)).resolves.toBe(false);
    expect(client.set).toHaveBeenCalledWith('test:ota:check:device-1', '1', { NX: true, EX: 60 });
  });

  it('returns true when redis SET succeeds', async () => {
    const client = {
      set: jest.fn().mockResolvedValue('OK')
    } as unknown as RedisClientType;

    await expect(checkOtaRateLimit(client, 'test:', 'device-1', 60)).resolves.toBe(true);
  });
});

describe('OTA signing state', () => {
  beforeEach(() => {
    setOtaSigningConfirmed(false);
    initOtaSigningState(false);
  });

  it('uses env confirmation when runtime flag is false', () => {
    expect(isOtaSigningConfirmed(true)).toBe(true);
    expect(isOtaSigningConfirmed(false)).toBe(false);
  });

  it('uses runtime confirmation after setOtaSigningConfirmed', () => {
    setOtaSigningConfirmed(true);
    expect(isOtaSigningConfirmed(false)).toBe(true);
  });
});

describe('isValidObjectId', () => {
  it('returns true for valid ObjectId strings', () => {
    expect(isValidObjectId('507f1f77bcf86cd799439011')).toBe(true);
  });

  it('returns false for invalid ObjectId strings', () => {
    expect(isValidObjectId('not-an-object-id')).toBe(false);
  });
});
