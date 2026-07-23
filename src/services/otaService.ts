/**
 * OTA — update resolution, release validation, CI webhook ingest, device state.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import mongoose from 'mongoose';
import type { RedisClientType } from 'redis';
import type { MqttClientManager } from '../servers/mqttClient';
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
import {
  normalizeOtaEventKey,
  parsePilotOtaFailPayload
} from '../utils/pilotOtaPayload';
import { getInfluxService } from './influxService';
import type { IFirmwareStorage, ObjectHeadResult } from './firmwareStorageService';
import { OciStorageError } from './ociStorageErrors';
import { getActiveDeviceCache } from './deviceService';
import { AuditEventType, getAuditService } from './auditService';
import { getOtaReleaseLog } from './otaReleaseLog';
import { getReleaseObjectKey } from '../utils/firmwareReleaseKey';
import {
  buildOtaMqttDownloadUrl,
  isLocalLanDownloadUrl,
  isOciFirmwareDownloadUrl
} from '../utils/otaDownloadUrl';

// ─── Release validation (finalize / CI webhook) ─────────────────────────────

export const OTA_MAX_FIRMWARE_BYTES = 2 * 1024 * 1024;

const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[a-zA-Z0-9._-]+)?$/;

export interface FinalizeValidationInput {
  version: string;
  sha256: string;
  signature: string;
  head: ObjectHeadResult;
  signingPublicKeyPem?: string;
  /** @deprecated use signingPublicKeyPem */
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

export function computeSigningKeyFingerprint(publicKeyPem: string): string {
  const pubKey = crypto.createPublicKey(publicKeyPem);
  return crypto.createHash('sha256')
    .update(pubKey.export({ type: 'spki', format: 'der' }))
    .digest('hex')
    .slice(0, 16);
}

export function verifyEd25519Signature(
  sha256Hex: string,
  signatureB64: string,
  publicKeyPem: string
): boolean {
  const pem = publicKeyPem.includes('-----BEGIN')
    ? publicKeyPem
    : fs.readFileSync(publicKeyPem, 'utf8');
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
  const { version, sha256, signature, head, signingPublicKeyPem, signingPublicKeyPath } = input;

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

  let publicKeyPem = signingPublicKeyPem?.trim();
  if (!publicKeyPem && signingPublicKeyPath && fs.existsSync(signingPublicKeyPath)) {
    publicKeyPem = fs.readFileSync(signingPublicKeyPath, 'utf8');
  }

  if (!publicKeyPem) {
    throw new FinalizeValidationError(
      'OTA_ED25519_PUBLIC_KEY_BASE64 is required for signature verification',
      'SIGNING_KEY_MISSING',
      503
    );
  }

  if (!verifyEd25519Signature(sha256, signature, publicKeyPem)) {
    throw new FinalizeValidationError('Ed25519 signature verification failed', 'INVALID_SIGNATURE');
  }
}

// ─── OTA Redis State ──────────────────────────────────────────────────────

export interface OtaActiveRelease {
  version: string;
  sha256: string;
  signature: string;
  objectKey: string;
  sizeBytes: number;
  releasedAt: string;
  keyFingerprint?: string;
}

export class OtaRedisState {
  constructor(
    private readonly getClient: () => RedisClientType | null,
    private readonly keyPrefix: string
  ) {}

  private activeReleaseKey(): string {
    return `${this.keyPrefix}ota:active_release`;
  }

  private pendingKey(version: string): string {
    return `${this.keyPrefix}ota:pending:${version}`;
  }

  private deliveredKey(version: string): string {
    return `${this.keyPrefix}ota:delivered:${version}`;
  }

  async setActiveRelease(release: OtaActiveRelease): Promise<void> {
    const client = this.getClient();
    if (!client) {
      logger.warn('[OTA] Redis unavailable — skipping setActiveRelease');
      return;
    }
    await client.set(this.activeReleaseKey(), JSON.stringify(release), { EX: 2592000 });
  }

  async getActiveRelease(): Promise<OtaActiveRelease | null> {
    const client = this.getClient();
    if (!client) return null;
    const raw = await client.get(this.activeReleaseKey());
    if (!raw) return null;
    try {
      return JSON.parse(raw) as OtaActiveRelease;
    } catch {
      return null;
    }
  }

  async seedPendingFleet(version: string, deviceIds: string[]): Promise<void> {
    const client = this.getClient();
    if (!client || deviceIds.length === 0) return;
    const key = this.pendingKey(version);
    await client.del(key);
    await client.sAdd(key, deviceIds);
    await client.expire(key, 2592000);
  }

  async isPending(deviceId: string, version: string): Promise<boolean> {
    const client = this.getClient();
    if (!client) return true;
    return Boolean(await client.sIsMember(this.pendingKey(version), deviceId));
  }

  async isDelivered(deviceId: string, version: string): Promise<boolean> {
    const client = this.getClient();
    if (!client) return false;
    return Boolean(await client.sIsMember(this.deliveredKey(version), deviceId));
  }

  async markDelivered(deviceId: string, version: string): Promise<void> {
    const client = this.getClient();
    if (!client) return;
    await client.sRem(this.pendingKey(version), deviceId);
    await client.sAdd(this.deliveredKey(version), deviceId);
    await client.expire(this.deliveredKey(version), 2592000);
  }

  async markPending(deviceId: string, version: string): Promise<void> {
    const client = this.getClient();
    if (!client) return;
    await client.sAdd(this.pendingKey(version), deviceId);
    await client.expire(this.pendingKey(version), 2592000);
  }
}

// ─── OTA Command Publisher ───────────────────────────────────────────────

export interface OtaUpdateCommandPayload {
  cmd: 'ota_update';
  version: string;
  download_url: string;
  sha256: string;
  signature: string;
  size_bytes: number;
  force: boolean;
  track?: string;
  issued_at: string;
}

export class OtaCommandPublisher {
  constructor(
    private readonly mqttClient: MqttClientManager,
    private readonly topicRoot: string,
    private readonly broadcastTopic: string,
    private readonly otaRedisState?: OtaRedisState,
    private readonly otaConfig?: OtaConfig
  ) {}

  private assertPublishableDownloadUrl(downloadUrl: string, version: string): void {
    if (isLocalLanDownloadUrl(downloadUrl)) {
      throw new Error(
        `[OTA] Refusing to publish LAN/dev download_url for ${version} — use OCI Object Storage PAR`
      );
    }
    // TEST_OTA: allow HTTP proxy download URLs (e.g. /api/v1/ota/download/proof:1.0.1).
    if (process.env.TEST_OTA === 'true') {
      return;
    }
    if (!isOciFirmwareDownloadUrl(downloadUrl)) {
      throw new Error(
        `[OTA] Refusing to publish non-OCI download_url for ${version} — MQTT ota_update requires OCI presigned PAR`
      );
    }
  }

  async publishUpdateToDevice(
    deviceId: string,
    offer: OtaUpdateOffer,
    force = false
  ): Promise<void> {
    this.assertPublishableDownloadUrl(offer.downloadUrl, offer.version);

    const payload: OtaUpdateCommandPayload = {
      cmd: 'ota_update',
      version: offer.version,
      download_url: offer.downloadUrl,
      sha256: offer.sha256,
      signature: offer.signature,
      size_bytes: offer.sizeBytes,
      force,
      track: offer.track,
      issued_at: new Date().toISOString()
    };

    const topic = `${this.topicRoot}/${deviceId}/cmd`;
    await this.mqttClient.publish(
      {
        topic,
        payload: JSON.stringify(payload),
        qos: 2,
        retain: false
      },
      {
        deviceId,
        onDelivered: this.otaRedisState
          ? () => {
              void this.otaRedisState!.markDelivered(deviceId, offer.version).catch((err: unknown) => {
                logger.warn('[OTA] markDelivered failed after MQTT ack', {
                  deviceId,
                  version: offer.version,
                  error: err instanceof Error ? err.message : String(err)
                });
              });
              void getAuditService()
                ?.logEvent({
                  event: AuditEventType.OTA_COMMAND_DELIVERED,
                  deviceId,
                  details: { version: offer.version, sha256: offer.sha256, keyFingerprint: offer.keyFingerprint }
                })
                .catch(() => undefined);
            }
          : undefined
      }
    );

    await Device.updateOne(
      { clientId: deviceId },
      {
        $set: {
          otaState: DeviceOtaState.NOTIFIED,
          otaTargetVersion: offer.version
        }
      }
    );

    void getAuditService()
      ?.logEvent({
        event: AuditEventType.OTA_COMMAND_ISSUED,
        deviceId,
        details: { version: offer.version, sha256: offer.sha256, force, topic, keyFingerprint: offer.keyFingerprint }
      })
      .catch(() => undefined);

    logger.info('[OTA] Published ota_update cmd', { deviceId, version: offer.version, topic });
  }

  async publishBroadcastUpdate(offer: OtaUpdateOffer, force = false): Promise<void> {
    this.assertPublishableDownloadUrl(offer.downloadUrl, offer.version);

    const payload: OtaUpdateCommandPayload = {
      cmd: 'ota_update',
      version: offer.version,
      download_url: offer.downloadUrl,
      sha256: offer.sha256,
      signature: offer.signature,
      size_bytes: offer.sizeBytes,
      force,
      track: offer.track,
      issued_at: new Date().toISOString()
    };

    const topic = this.broadcastTopic;
    await this.mqttClient.publish({
      topic,
      payload: JSON.stringify(payload),
      qos: 1,
      retain: false
    });

    void getAuditService()
      ?.logEvent({
        event: AuditEventType.OTA_COMMAND_ISSUED,
        details: { version: offer.version, sha256: offer.sha256, force, topic, broadcast: true, keyFingerprint: offer.keyFingerprint }
      })
      .catch(() => undefined);

    logger.info('[OTA] Published broadcast ota_update', {
      version: offer.version,
      topic: this.broadcastTopic
    });
  }

  async publishRollbackAck(deviceId: string, version: string): Promise<void> {
    const topic = `${this.topicRoot}/${deviceId}/ack`;
    await this.mqttClient.publish({
      topic,
      payload: JSON.stringify({
        cmd: 'ota_rollback_received',
        version,
        received_at: new Date().toISOString()
      }),
      qos: 1,
      retain: false
    });

    logger.info('[OTA] Published rollback ack', { deviceId, version, topic });
  }
}

// ─── OTA Event Handler ────────────────────────────────────────────────────

export type OtaEventPayload = {
  type?: string;
  event?: string;
  version?: string;
  attempted_version?: string;
  reason?: string;
  reasons?: string[];
  boot_attempts?: number;
  progress?: number;
  status?: string;
  metadata?: Record<string, unknown>;
};

function eventKey(payload: OtaEventPayload): string | undefined {
  return normalizeOtaEventKey(payload);
}

export class OtaEventHandler {
  constructor(
    private readonly otaService: OtaService,
    private readonly commandPublisher: OtaCommandPublisher
  ) {}

  async handle(deviceId: string, payload: OtaEventPayload): Promise<void> {
    const key = eventKey(payload);
    if (!key) return;

    const device = await Device.findOne({ clientId: deviceId }).select({ firmwareVersion: 1, otaState: 1 }).lean();
    const previousFirmwareVersion = device?.firmwareVersion || 'unknown';

    const active = await this.otaService.getActiveReleaseMeta().catch(() => null);

    switch (key) {
      case 'ota_progress':
      case 'ota_validating': {
        logger.debug('[OTA] Pilot ignores progress/validation event', { deviceId, key });
        break;
      }

      case 'ota_success': {
        const version = payload.version || '';
        if (version) {
          await this.otaService.recordOtaSuccess(deviceId, version);
          await this.otaService.markDeviceDelivered(deviceId, version);
        }
        void getAuditService()
          ?.logEvent({
            event: AuditEventType.OTA_SUCCESS,
            deviceId,
            details: {
              version,
              sha256: active?.sha256,
              signingKeyFingerprint: active?.keyFingerprint,
              previousFirmwareVersion
            }
          })
          .catch(() => undefined);
        break;
      }

      case 'ota_fail':
      case 'ota_rollback': {
        const pilot = parsePilotOtaFailPayload(payload);
        const version = pilot.version || payload.attempted_version || payload.version || '';
        const reason = pilot.reason || payload.reason ||
          (Array.isArray(payload.reasons) ? payload.reasons.join('; ') : undefined);

        const { blocked, failures } = await this.otaService.recordOtaFailure(
          deviceId,
          version,
          reason
        );

        void getInfluxService()
          ?.writeDeviceOtaEvent({
            deviceId,
            event: 'ota_fail',
            sourceTopic: 'status',
            fwVersion: version,
            reason,
            timestamp: pilot.timestamp
          })
          .catch(() => undefined);

        void getAuditService()
          ?.logEvent({
            event: key === 'ota_rollback' ? AuditEventType.OTA_ROLLBACK : AuditEventType.OTA_ROLLBACK,
            deviceId,
            details: {
              version,
              sha256: active?.sha256,
              signingKeyFingerprint: active?.keyFingerprint,
              previousFirmwareVersion,
              reason,
              failures,
              blocked
            }
          })
          .catch(() => undefined);

        if (key === 'ota_rollback' && version) {
          await this.commandPublisher.publishRollbackAck(deviceId, version);
        }
        break;
      }

      default:
        logger.debug('[OTA] Ignored status event', { deviceId, key });
    }
  }
}

// ─── OTA Rate Limiter ─────────────────────────────────────────────────────

export async function checkOtaRateLimit(
  client: RedisClientType | null,
  keyPrefix: string,
  deviceId: string,
  windowSec: number
): Promise<boolean> {
  if (!client || windowSec <= 0) {
    return true;
  }

  const key = `${keyPrefix}ota:check:${deviceId}`;
  try {
    const set = await client.set(key, '1', { NX: true, EX: windowSec });
    return set === 'OK';
  } catch (err: unknown) {
    logger.warn('[OTA] Rate limit check failed — allowing request', {
      deviceId,
      error: err instanceof Error ? err.message : String(err)
    });
    return true;
  }
}

// ─── OTA Signing State ────────────────────────────────────────────────────

let runtimeSigningConfirmed = false;

export function initOtaSigningState(envConfirmed: boolean): void {
  runtimeSigningConfirmed = envConfirmed;
}

export function isOtaSigningConfirmed(envConfirmed: boolean): boolean {
  return envConfirmed || runtimeSigningConfirmed;
}

export function setOtaSigningConfirmed(confirmed: boolean): void {
  runtimeSigningConfirmed = confirmed;
}

export function getRuntimeSigningConfirmed(): boolean {
  return runtimeSigningConfirmed;
}

// ─── Update resolution & device state ───────────────────────────────────────

export interface OtaUpdateOffer {
  version: string;
  downloadUrl: string;
  sha256: string;
  signature: string;
  sizeBytes: number;
  expiresAt: string;
  keyFingerprint?: string;
  track?: string;
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
    private readonly commandPublisher?: OtaCommandPublisher,
    private readonly otaRedisState?: OtaRedisState
  ) {}

  async resolveUpdate(input: ResolveUpdateInput): Promise<OtaUpdateOffer | null> {
    const device = await Device.findOne({ clientId: input.deviceId });
    if (!device) {
      logger.warn('[OTA] Device not found for check', { deviceId: input.deviceId });
      void getAuditService()
        ?.logEvent({
          event: AuditEventType.OTA_CHECK_NO_UPDATE,
          deviceId: input.deviceId,
          details: { currentVersion: input.currentVersion, reason: 'device_not_found' }
        })
        .catch(() => undefined);
      return null;
    }

    if (!this.isDeviceEligible(device)) {
      void getAuditService()
        ?.logEvent({
          event: AuditEventType.OTA_CHECK_NO_UPDATE,
          deviceId: input.deviceId,
          details: { currentVersion: input.currentVersion, reason: 'device_not_eligible', status: device.status }
        })
        .catch(() => undefined);
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

        void getAuditService()
          ?.logEvent({
            event: AuditEventType.OTA_CHECK_OFFERED,
            deviceId: input.deviceId,
            details: { version: release.version, currentVersion: input.currentVersion, downloadUrl: offer.downloadUrl }
          })
          .catch(() => undefined);

        return offer;
      }
    }

    device.otaLastCheckAt = new Date();
    await device.save();

    void getAuditService()
      ?.logEvent({
        event: AuditEventType.OTA_CHECK_NO_UPDATE,
        deviceId: input.deviceId,
        details: { currentVersion: input.currentVersion, reason: 'no_newer_release' }
      })
      .catch(() => undefined);

    return null;
  }

  async ingestRelease(input: OtaReleaseWebhookInput): Promise<OtaReleaseWebhookResult> {
    const version = input.version.trim();
    const objectKey = input.objectKey.trim();
    const sha256 = input.sha256.trim().toLowerCase();
    const signature = input.signature.trim();
    const shouldPush = input.broadcast !== false;

    if (!version || !objectKey || !sha256 || !signature) {
      return {
        ok: false,
        httpStatus: 400,
        code: 'MISSING_FIELDS',
        error: 'version, object_key, sha256, and signature are required'
      };
    }

    if (shouldPush && !this.commandPublisher) {
      return {
        ok: false,
        httpStatus: 503,
        code: 'MQTT_NOT_READY',
        error: 'OTA command publisher is not configured'
      };
    }

    const signingKeyPem = this.otaConfig.signingPublicKeyPem;
    const keyFingerprint = signingKeyPem ? computeSigningKeyFingerprint(signingKeyPem) : undefined;

    try {
      const head = await this.storage.headObject(objectKey);

      validateFinalizeInput({
        version,
        sha256,
        signature,
        head,
        signingPublicKeyPem: signingKeyPem,
        signingPublicKeyPath: this.otaConfig.signingPublicKeyPath
      });

      void getAuditService()
        ?.logEvent({
          event: AuditEventType.OTA_RELEASE_VALIDATED,
          details: {
            version, sha256, signature, keyFingerprint,
            result: true, source: 'webhook'
          }
        })
        .catch(() => undefined);

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

      const releasedAtIso = input.releasedAt || new Date().toISOString();

      if (this.otaRedisState) {
        await this.otaRedisState.setActiveRelease({
          version: release.version,
          sha256: release.sha256,
          signature: release.signature,
          objectKey,
          sizeBytes: release.sizeBytes,
          releasedAt: releasedAtIso,
          keyFingerprint
        });

        const eligibleIds = await this.listEligibleDeviceIds();
        await this.otaRedisState.seedPendingFleet(release.version, eligibleIds);
      }

      void getOtaReleaseLog()?.addEntry(version, sha256, objectKey, keyFingerprint, input.releasedAt ? new Date(input.releasedAt) : undefined).catch(() => undefined);

      let pushedCount = 0;
      if (shouldPush) {
        pushedCount = await this.pushReleaseToOnlineDevices(release.version);

        void getAuditService()
          ?.logEvent({
            event: AuditEventType.OTA_PUSH_SENT,
            details: {
              version,
              target: 'device',
              mode: 'full',
              source: 'webhook',
              pushedCount
            }
          })
          .catch(() => undefined);
      }

      logger.info('[OTA] Release ingested from CI webhook', {
        version,
        objectKey,
        pushedCount,
        created
      });

      return { ok: true, version, broadcast: shouldPush, created };
    } catch (err: unknown) {
      if (err instanceof FinalizeValidationError) {
        void getAuditService()
          ?.logEvent({
            event: AuditEventType.OTA_RELEASE_VALIDATED,
            details: { version, sha256, keyFingerprint, result: false, code: err.code, error: err.message, source: 'webhook' }
          })
          .catch(() => undefined);
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

  async deliverPendingToDevice(deviceId: string, currentVersion: string): Promise<void> {
    if (!this.commandPublisher || !this.otaRedisState) return;

    const active = await this.otaRedisState.getActiveRelease();
    if (!active) return;
    if (!isVersionGreater(active.version, currentVersion)) return;
    if (await this.otaRedisState.isDelivered(deviceId, active.version)) return;
    if (!(await this.otaRedisState.isPending(deviceId, active.version))) return;

    const device = await Device.findOne({ clientId: deviceId });
    if (!device || !this.isDeviceEligible(device)) return;

    const release = await FirmwareRelease.findOne({
      version: active.version,
      status: FirmwareReleaseStatus.STABLE
    });
    if (!release) {
      logger.warn('[OTA] Active release missing from DB', { version: active.version, deviceId });
      return;
    }
    if (!this.matchesRollout(release, device, deviceId)) return;

    const offer = await this.buildOffer(release);
    if (!offer) return;

    await this.commandPublisher.publishUpdateToDevice(deviceId, offer, false);
  }

  async getLatestStableOffer(deviceId: string): Promise<OtaUpdateOffer | null> {
    const device = await Device.findOne({ clientId: deviceId });
    if (!device || !this.isDeviceEligible(device)) return null;

    const release = await FirmwareRelease.findOne({ status: FirmwareReleaseStatus.STABLE })
      .sort({ releasedAt: -1, createdAt: -1 });

    if (!release) return null;

    return this.buildOffer(release);
  }

  private async listEligibleDeviceIds(): Promise<string[]> {
    const devices = await Device.find({
      status: { $in: [DeviceStatus.PROVISIONED, DeviceStatus.ACTIVE, DeviceStatus.OFFLINE] }
    })
      .select({ clientId: 1 })
      .lean();
    return devices.map((d) => d.clientId).filter(Boolean);
  }

  private async pushReleaseToOnlineDevices(version: string): Promise<number> {
    if (!this.commandPublisher) return 0;

    const online = await getActiveDeviceCache().getAllActive();
    const onlineIds = new Set(online.map((d) => d.deviceId));
    let pushed = 0;

    for (const deviceId of onlineIds) {
      if (!this.otaRedisState || !(await this.otaRedisState.isPending(deviceId, version))) {
        continue;
      }

      const device = await Device.findOne({ clientId: deviceId });
      const currentVersion = device?.firmwareVersion || '0.0.0';
      const offer = await this.resolveUpdate({ deviceId, currentVersion });
      if (!offer || offer.version !== version) continue;

      await this.commandPublisher.publishUpdateToDevice(deviceId, offer, false);
      pushed++;
    }

    return pushed;
  }

  async markDeviceDelivered(deviceId: string, version: string): Promise<void> {
    await this.otaRedisState?.markDelivered(deviceId, version);
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
      const downloadUrl = await buildOtaMqttDownloadUrl(release, this.otaConfig, this.storage);
      const keyFingerprint = this.otaConfig.signingPublicKeyPem
        ? computeSigningKeyFingerprint(this.otaConfig.signingPublicKeyPem)
        : undefined;

      return {
        version: release.version,
        downloadUrl,
        sha256: release.sha256,
        signature: release.signature,
        sizeBytes: release.sizeBytes,
        expiresAt: expiresAt.toISOString(),
        keyFingerprint,
        track: 'pilot'
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

  async getActiveReleaseMeta(): Promise<{ sha256?: string; keyFingerprint?: string; signature?: string } | null> {
    if (!this.otaRedisState) return null;
    const active = await this.otaRedisState.getActiveRelease();
    if (!active) return null;
    return {
      sha256: active.sha256,
      signature: active.signature,
      keyFingerprint: active.keyFingerprint,
    };
  }

  async recordRollbackFailure(
    deviceId: string,
    version: string,
    reason?: string
  ): Promise<{ blocked: boolean; failures: number }> {
    return this.recordOtaFailure(deviceId, version, reason);
  }

  async recordOtaFailure(
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

      void getAuditService()
        ?.logEvent({
          event: AuditEventType.OTA_DEVICE_BLOCKED,
          deviceId,
          details: { version, failures: next, threshold }
        })
        .catch(() => undefined);
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

  /** Pilot: success when next boot reports fw_version matching pending target or active release. */
  async maybeRecordImplicitOtaSuccess(deviceId: string, fwVersion: string): Promise<void> {
    if (!fwVersion.trim()) return;

    const device = await Device.findOne({ clientId: deviceId })
      .select({ otaTargetVersion: 1, firmwareVersion: 1 })
      .lean();
    const active = await this.otaRedisState?.getActiveRelease().catch(() => null);

    const target = device?.otaTargetVersion?.trim() || active?.version?.trim();
    if (!target || target !== fwVersion.trim()) return;
    if (device?.firmwareVersion === fwVersion) return;

    await this.recordOtaSuccess(deviceId, fwVersion);
    await this.markDeviceDelivered(deviceId, fwVersion);

    void getAuditService()
      ?.logEvent({
        event: AuditEventType.OTA_SUCCESS,
        deviceId,
        details: { version: fwVersion, implicit: true, previousFirmwareVersion: device?.firmwareVersion }
      })
      .catch(() => undefined);
  }

  async updateOtaState(deviceId: string, state: DeviceOtaState, previousState?: string): Promise<void> {
    const device = await Device.findOne({ clientId: deviceId }).select({ otaState: 1 });
    const oldState = previousState || device?.otaState || 'unknown';
    await Device.updateOne({ clientId: deviceId }, { $set: { otaState: state } });

    void getAuditService()
      ?.logEvent({
        event: AuditEventType.OTA_DEVICE_STATE_CHANGED,
        deviceId,
        details: { fromState: oldState, toState: state }
      })
      .catch(() => undefined);
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
