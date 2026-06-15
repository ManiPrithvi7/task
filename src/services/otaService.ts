/**
 * OTA — update resolution, release validation, CI webhook ingest, device state.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import mongoose from 'mongoose';
import type { OtaConfig } from '../config';
import {
  Device,
  DeviceStatus,
  DeviceOtaState,
  type IDevice
} from '../models/Device';
import {
  FirmwareRelease,
  FirmwareReleaseStatus,
  FirmwareRolloutStrategy,
  type IFirmwareRelease
} from '../models/FirmwareRelease';
import { isVersionGreater } from '../utils/semver';
import { logger } from '../utils/logger';
import type { IFirmwareStorage, ObjectHeadResult } from './firmwareStorageService';
import { OciStorageError } from './ociStorageErrors';
import type { OtaCommandPublisher } from './otaCommandPublisher';
import { AuditEventType, getAuditService } from './auditService';
import { getReleaseObjectKey } from '../utils/firmwareReleaseKey';

// ─── Release validation (finalize / CI webhook) ─────────────────────────────

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

// ─── Update resolution & device state ───────────────────────────────────────

export interface OtaUpdateOffer {
  version: string;
  downloadUrl: string;
  sha256: string;
  signature: string;
  sizeBytes: number;
  expiresAt: string;
}

export interface ResolveUpdateInput {
  deviceId: string;
  currentVersion: string;
  hardwareRev?: string;
  platform?: string;
}

export interface OtaReleaseWebhookInput {
  version: string;
  objectKey: string;
  sha256: string;
  signature: string;
  sizeBytes?: number;
  releasedAt?: string;
  broadcast?: boolean;
}

export type OtaReleaseWebhookResult =
  | { ok: true; version: string; broadcast: boolean; created: boolean }
  | { ok: false; httpStatus: number; code: string; error: string };

export class OtaService {
  constructor(
    private readonly otaConfig: OtaConfig,
    private readonly storage: IFirmwareStorage,
    private readonly publicBaseUrl: string,
    private readonly commandPublisher?: OtaCommandPublisher
  ) {}

  async resolveUpdate(input: ResolveUpdateInput): Promise<OtaUpdateOffer | null> {
    const device = await Device.findOne({ clientId: input.deviceId });
    if (!device) {
      logger.warn('[OTA] Device not found for check', { deviceId: input.deviceId });
      return null;
    }

    if (!this.isDeviceEligible(device)) {
      return null;
    }

    const blocked = new Set(device.otaBlockedVersions || []);
    const releases = await FirmwareRelease.find({ status: FirmwareReleaseStatus.STABLE })
      .sort({ releasedAt: -1, createdAt: -1 })
      .limit(20);

    for (const release of releases) {
      if (blocked.has(release.version)) continue;
      if (!isVersionGreater(release.version, input.currentVersion)) continue;
      if (!this.matchesRollout(release, device, input.deviceId)) continue;
      if (!this.matchesHardware(release, input.hardwareRev, input.platform)) continue;

      const offer = await this.buildOffer(release);
      if (offer) {
        device.otaLastCheckAt = new Date();
        device.otaTargetVersion = release.version;
        await device.save();
        return offer;
      }
    }

    device.otaLastCheckAt = new Date();
    await device.save();
    return null;
  }

  async ingestRelease(input: OtaReleaseWebhookInput): Promise<OtaReleaseWebhookResult> {
    const version = input.version.trim();
    const objectKey = input.objectKey.trim();
    const sha256 = input.sha256.trim().toLowerCase();
    const signature = input.signature.trim();
    const shouldBroadcast = input.broadcast !== false;

    if (!version || !objectKey || !sha256 || !signature) {
      return {
        ok: false,
        httpStatus: 400,
        code: 'MISSING_FIELDS',
        error: 'version, object_key, sha256, and signature are required'
      };
    }

    if (shouldBroadcast && !this.commandPublisher) {
      return {
        ok: false,
        httpStatus: 503,
        code: 'MQTT_NOT_READY',
        error: 'OTA command publisher is not configured'
      };
    }

    try {
      const head = await this.storage.headObject(objectKey);
      validateFinalizeInput({
        version,
        sha256,
        signature,
        head,
        signingPublicKeyPath: this.otaConfig.signingPublicKeyPath
      });

      const shaOk = await this.storage.verifySha256(objectKey, sha256);
      if (!shaOk) {
        return {
          ok: false,
          httpStatus: 400,
          code: 'SHA256_MISMATCH',
          error: 'sha256 does not match object bytes'
        };
      }

      const sizeBytes = input.sizeBytes ?? head.sizeBytes;
      const existing = await FirmwareRelease.findOne({ version });
      const created = !existing;

      const release = await FirmwareRelease.findOneAndUpdate(
        { version },
        {
          version,
          sha256,
          signature,
          objectKey,
          s3Key: objectKey,
          sizeBytes,
          status: FirmwareReleaseStatus.STABLE,
          rollout: { strategy: FirmwareRolloutStrategy.ALL },
          releasedAt: input.releasedAt ? new Date(input.releasedAt) : new Date(),
          createdBy: 'ota-release-webhook'
        },
        { upsert: true, new: true }
      );

      void getAuditService()
        ?.logEvent({
          event: AuditEventType.OTA_RELEASE_PROMOTED,
          details: { version, objectKey, source: 'webhook', created }
        })
        .catch(() => undefined);

      if (shouldBroadcast) {
        const downloadUrl =
          this.otaConfig.downloadMode === 'proxy'
            ? `${this.publicBaseUrl}/api/v1/ota/download/${encodeURIComponent(version)}`
            : await this.storage.createPresignedGetUrl(objectKey, version);
        const expiresAt = new Date(
          Date.now() + this.otaConfig.presignedUrlTtlSec * 1000
        ).toISOString();

        await this.commandPublisher!.publishBroadcastUpdate(
          {
            version: release.version,
            downloadUrl,
            sha256: release.sha256,
            signature: release.signature,
            sizeBytes: release.sizeBytes,
            expiresAt
          },
          false
        );

        void getAuditService()
          ?.logEvent({
            event: AuditEventType.OTA_PUSH_SENT,
            details: { version, target: 'broadcast', mode: 'full', source: 'webhook' }
          })
          .catch(() => undefined);
      }

      logger.info('[OTA] Release ingested from CI webhook', {
        version,
        objectKey,
        broadcast: shouldBroadcast,
        created
      });

      return { ok: true, version, broadcast: shouldBroadcast, created };
    } catch (err: unknown) {
      if (err instanceof FinalizeValidationError) {
        return {
          ok: false,
          httpStatus: err.httpStatus,
          code: err.code,
          error: err.message
        };
      }
      if (err instanceof OciStorageError) {
        return {
          ok: false,
          httpStatus: err.httpStatus,
          code: err.code,
          error: err.message
        };
      }
      logger.error('[OTA] Webhook ingest failed', {
        version,
        error: err instanceof Error ? err.message : String(err)
      });
      return {
        ok: false,
        httpStatus: 500,
        code: 'WEBHOOK_INGEST_ERROR',
        error: 'Failed to ingest OTA release'
      };
    }
  }

  private isDeviceEligible(device: IDevice): boolean {
    const allowed: DeviceStatus[] = [
      DeviceStatus.PROVISIONED,
      DeviceStatus.ACTIVE,
      DeviceStatus.OFFLINE
    ];
    if (!allowed.includes(device.status)) {
      logger.debug('[OTA] Device not eligible — status', {
        deviceId: device.clientId,
        status: device.status
      });
      return false;
    }
    return true;
  }

  private matchesHardware(
    release: IFirmwareRelease,
    hardwareRev?: string,
    platform?: string
  ): boolean {
    if (release.minHardwareRev && hardwareRev) {
      if (isVersionGreater(release.minHardwareRev, hardwareRev)) {
        return false;
      }
    }
    if (release.targetPlatforms?.length && platform) {
      if (!release.targetPlatforms.includes(platform)) {
        return false;
      }
    }
    return true;
  }

  private matchesRollout(release: IFirmwareRelease, device: IDevice, deviceId: string): boolean {
    const rollout = release.rollout || { strategy: FirmwareRolloutStrategy.ALL };
    const blocked = rollout.blockedDeviceIds || [];
    if (blocked.includes(deviceId)) {
      return false;
    }

    switch (rollout.strategy) {
      case FirmwareRolloutStrategy.ALLOWLIST: {
        const allow = rollout.deviceIds || [];
        if (allow.length === 0) return false;
        return allow.includes(deviceId);
      }
      case FirmwareRolloutStrategy.PERCENTAGE: {
        const pct = rollout.percentage ?? 100;
        if (pct >= 100) return true;
        const bucket = this.deviceHashBucket(deviceId);
        return bucket < pct;
      }
      case FirmwareRolloutStrategy.ALL:
      default:
        if (rollout.userIds?.length && device.userId) {
          const uid = device.userId.toString();
          if (!rollout.userIds.includes(uid)) {
            return false;
          }
        }
        return true;
    }
  }

  private deviceHashBucket(deviceId: string): number {
    const hash = crypto.createHash('sha256').update(deviceId).digest();
    return hash[0] % 100;
  }

  private async buildOffer(release: IFirmwareRelease): Promise<OtaUpdateOffer | null> {
    try {
      const expiresAt = new Date(Date.now() + this.otaConfig.presignedUrlTtlSec * 1000);
      let downloadUrl: string;

      if (this.otaConfig.downloadMode === 'proxy') {
        downloadUrl = `${this.publicBaseUrl}/api/v1/ota/download/${encodeURIComponent(release.version)}`;
      } else {
        downloadUrl = await this.storage.createPresignedGetUrl(
          getReleaseObjectKey(release),
          release.version
        );
      }

      return {
        version: release.version,
        downloadUrl,
        sha256: release.sha256,
        signature: release.signature,
        sizeBytes: release.sizeBytes,
        expiresAt: expiresAt.toISOString()
      };
    } catch (err: unknown) {
      logger.error('[OTA] Failed to build offer', {
        version: release.version,
        error: err instanceof Error ? err.message : String(err)
      });
      return null;
    }
  }

  async getStableRelease(version: string): Promise<IFirmwareRelease | null> {
    return FirmwareRelease.findOne({
      version,
      status: FirmwareReleaseStatus.STABLE
    });
  }

  async recordRollbackFailure(
    deviceId: string,
    version: string,
    reason?: string
  ): Promise<{ blocked: boolean; failures: number }> {
    const device = await Device.findOne({ clientId: deviceId });
    if (!device) {
      return { blocked: false, failures: 0 };
    }

    const failuresMap = device.otaRollbackFailures || new Map<string, number>();
    const prev = failuresMap.get(version) ?? 0;
    const next = prev + 1;
    failuresMap.set(version, next);
    device.otaRollbackFailures = failuresMap;
    device.otaState = DeviceOtaState.ROLLBACK_REPORTED;

    let blocked = false;
    const threshold = this.otaConfig.rollbackFailureThreshold;
    if (next >= threshold) {
      const blockedVersions = new Set(device.otaBlockedVersions || []);
      blockedVersions.add(version);
      device.otaBlockedVersions = Array.from(blockedVersions);
      blocked = true;
    }

    if (reason) {
      device.errorMessage = `OTA rollback ${version}: ${reason}`.slice(0, 500);
    }

    await device.save();
    return { blocked, failures: next };
  }

  async recordOtaSuccess(deviceId: string, version: string): Promise<void> {
    await Device.updateOne(
      { clientId: deviceId },
      {
        $set: {
          firmwareVersion: version,
          firmwareReportedAt: new Date(),
          otaState: DeviceOtaState.IDLE,
          otaTargetVersion: undefined
        }
      }
    );
  }

  async updateOtaState(deviceId: string, state: DeviceOtaState): Promise<void> {
    await Device.updateOne({ clientId: deviceId }, { $set: { otaState: state } });
  }

  async updateFirmwareVersion(deviceId: string, version: string): Promise<void> {
    if (!version?.trim()) return;
    await Device.updateOne(
      { clientId: deviceId },
      {
        $set: {
          firmwareVersion: version.trim(),
          firmwareReportedAt: new Date()
        }
      }
    );
  }
}

export function isValidObjectId(value: string): boolean {
  return mongoose.Types.ObjectId.isValid(value);
}
