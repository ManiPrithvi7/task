/**
 * OTA release validation at finalize — SHA-256, Ed25519, metadata, size, version format.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import type { ObjectHeadResult } from './firmwareStorageService';

export const OTA_MAX_FIRMWARE_BYTES = 2 * 1024 * 1024;

const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[a-zA-Z0-9._-]+)?$/;

export interface FinalizeValidationInput {
  version: string;
  sha256: string;
  signature: string;
  head: ObjectHeadResult;
  signingPublicKeyPath?: string;
}

export type FinalizeValidationCode =
  | 'INVALID_SHA256'
  | 'INVALID_SIGNATURE'
  | 'SIGNING_KEY_MISSING'
  | 'INVALID_VERSION'
  | 'SIZE_INVALID'
  | 'SIZE_MISMATCH'
  | 'METADATA_VERSION_MISMATCH'
  | 'METADATA_SHA256_MISMATCH'
  | 'METADATA_MISSING';

export class FinalizeValidationError extends Error {
  readonly code: FinalizeValidationCode;
  readonly httpStatus: number;

  constructor(message: string, code: FinalizeValidationCode, httpStatus = 400) {
    super(message);
    this.name = 'FinalizeValidationError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function assertValidVersionFormat(version: string): void {
  if (!VERSION_PATTERN.test(version)) {
    throw new FinalizeValidationError(
      'version must match semver pattern (e.g. 4.3.1 or 4.3.1-mvp)',
      'INVALID_VERSION'
    );
  }
}

export function assertValidSha256Hex(sha256: string): void {
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new FinalizeValidationError('sha256 must be 64 lowercase hex characters', 'INVALID_SHA256');
  }
}

export function verifyEd25519Signature(
  sha256Hex: string,
  signatureB64: string,
  publicKeyPemPath: string
): boolean {
  const pem = fs.readFileSync(publicKeyPemPath, 'utf8');
  const pubKey = crypto.createPublicKey(pem);
  const message = Buffer.from(sha256Hex.toLowerCase(), 'utf8');
  let sig: Buffer;
  try {
    sig = Buffer.from(signatureB64, 'base64');
  } catch {
    return false;
  }
  if (sig.length !== 64) {
    return false;
  }
  return crypto.verify(null, message, pubKey, sig);
}

export function validateFinalizeInput(input: FinalizeValidationInput): void {
  const { version, sha256, signature, head, signingPublicKeyPath } = input;

  assertValidVersionFormat(version);
  assertValidSha256Hex(sha256);

  if (!head.sizeBytes || head.sizeBytes <= 0) {
    throw new FinalizeValidationError('Object size is zero or missing', 'SIZE_INVALID', 404);
  }
  if (head.sizeBytes > OTA_MAX_FIRMWARE_BYTES) {
    throw new FinalizeValidationError(
      `Firmware size ${head.sizeBytes} exceeds maximum ${OTA_MAX_FIRMWARE_BYTES}`,
      'SIZE_INVALID'
    );
  }

  if (!head.firmwareVersion) {
    throw new FinalizeValidationError(
      'Object missing opc-meta-firmware-version — set on upload PUT',
      'METADATA_MISSING'
    );
  }
  if (!head.sha256) {
    throw new FinalizeValidationError(
      'Object missing opc-meta-sha256 — set on upload PUT',
      'METADATA_MISSING'
    );
  }
  if (head.firmwareVersion !== version) {
    throw new FinalizeValidationError(
      `Metadata version mismatch: object has '${head.firmwareVersion}', expected '${version}'`,
      'METADATA_VERSION_MISMATCH'
    );
  }
  if (head.sha256.toLowerCase() !== sha256.toLowerCase()) {
    throw new FinalizeValidationError(
      'Metadata sha256 does not match finalize request',
      'METADATA_SHA256_MISMATCH'
    );
  }

  if (!signingPublicKeyPath || !fs.existsSync(signingPublicKeyPath)) {
    throw new FinalizeValidationError(
      'OTA_ED25519_PUBLIC_KEY_PATH is required for finalize signature verification',
      'SIGNING_KEY_MISSING',
      503
    );
  }

  if (!verifyEd25519Signature(sha256, signature, signingPublicKeyPath)) {
    throw new FinalizeValidationError('Ed25519 signature verification failed', 'INVALID_SIGNATURE');
  }
}
