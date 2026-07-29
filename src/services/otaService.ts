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
import {
  buildOtaMqttDownloadUrl,
  isLocalLanDownloadUrl,
  isOciFirmwareDownloadUrl
} from '../utils/otaDownloadUrl';
import {
  canAdvanceStage,
  classifyOtaReason,
  deviceHashBucket,
  isValidRolloutStep,
  mapPool,
  nextRolloutPercentage,
  shouldAbortStage,
  shouldIncrementFailed,
  shouldIncrementRolledBack,
  stageFailureRate
} from '../utils/otaRollout';
import { sendOtaSlackAlert } from '../notifications/slackOta';
import type { IFirmwareRollout } from '../models/FirmwareRelease';

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

/** Max members per SMISMEMBER call (arg-size / server-block safety). */
export const SMISMEMBER_CHUNK_SIZE = 500;

let loggedSMisMemberFallback = false;

export class OtaRedisState {
  constructor(
    private readonly getClient: () => RedisClientType | null,
    private readonly keyPrefix: string
  ) {}

  private activeReleaseKey(): string {
    return `${this.keyPrefix}ota:active_release`;
  }

  private previousActiveReleaseKey(): string {
    return `${this.keyPrefix}ota:previous_active_release`;
  }

  private pendingKey(version: string): string {
    return `${this.keyPrefix}ota:pending:${version}`;
  }

  private deliveredKey(version: string): string {
    return `${this.keyPrefix}ota:delivered:${version}`;
  }

  private stageAttemptedKey(version: string, percentage: number): string {
    return `${this.keyPrefix}ota:stage:${version}:${percentage}:attempted`;
  }

  private deferredLogKey(deviceId: string): string {
    return `${this.keyPrefix}ota:deferred:${deviceId}`;
  }

  schedulerLockKey(): string {
    return `${this.keyPrefix}ota:scheduler:lock`;
  }

  schedulerLastRunKey(): string {
    return `${this.keyPrefix}ota:scheduler:last_run`;
  }

  async setActiveRelease(release: OtaActiveRelease): Promise<void> {
    const client = this.getClient();
    if (!client) {
      logger.warn('[OTA] Redis unavailable — skipping setActiveRelease');
      return;
    }
    const current = await this.getActiveRelease();
    if (current && current.version !== release.version) {
      await client.set(this.previousActiveReleaseKey(), JSON.stringify(current), { EX: 2592000 });
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

  async getPreviousActiveRelease(): Promise<OtaActiveRelease | null> {
    const client = this.getClient();
    if (!client) return null;
    const raw = await client.get(this.previousActiveReleaseKey());
    if (!raw) return null;
    try {
      return JSON.parse(raw) as OtaActiveRelease;
    } catch {
      return null;
    }
  }

  async clearActiveRelease(): Promise<void> {
    const client = this.getClient();
    if (!client) return;
    await client.del(this.activeReleaseKey());
  }

  /** Set active without copying current → previous (used on abort restore). */
  async forceSetActiveRelease(release: OtaActiveRelease): Promise<void> {
    const client = this.getClient();
    if (!client) {
      logger.warn('[OTA] Redis unavailable — skipping forceSetActiveRelease');
      return;
    }
    await client.set(this.activeReleaseKey(), JSON.stringify(release), { EX: 2592000 });
  }

  async seedPendingFleet(version: string, deviceIds: string[]): Promise<void> {
    const client = this.getClient();
    if (!client) return;
    const key = this.pendingKey(version);
    await client.del(key);
    if (deviceIds.length === 0) return;
    await client.sAdd(key, deviceIds);
    await client.expire(key, 2592000);
  }

  async addPendingDevices(version: string, deviceIds: string[]): Promise<void> {
    const client = this.getClient();
    if (!client || deviceIds.length === 0) return;
    const key = this.pendingKey(version);
    await client.sAdd(key, deviceIds);
    await client.expire(key, 2592000);
  }

  async clearPendingFleet(version: string): Promise<void> {
    const client = this.getClient();
    if (!client) return;
    await client.del(this.pendingKey(version));
  }

  async isPending(deviceId: string, version: string): Promise<boolean> {
    const client = this.getClient();
    if (!client) return true;
    return Boolean(await client.sIsMember(this.pendingKey(version), deviceId));
  }

  /**
   * Batch filter of device IDs that are members of the pending set.
   * Same as isPending(): when Redis is unavailable (!client), treat all as pending
   * (fail open for OTA push — may attempt delivery to all online devices during outage).
   */
  async filterPending(version: string, deviceIds: string[]): Promise<string[]> {
    const client = this.getClient();
    if (!client) return deviceIds;
    if (deviceIds.length === 0) return [];

    const key = this.pendingKey(version);
    const pending: string[] = [];

    const hasSMisMember = typeof (client as { smIsMember?: unknown }).smIsMember === 'function';
    if (!hasSMisMember) {
      if (!loggedSMisMemberFallback) {
        loggedSMisMemberFallback = true;
        logger.warn('[OTA] smIsMember unavailable — falling back to sequential sIsMember');
      }
      for (const id of deviceIds) {
        if (await client.sIsMember(key, id)) pending.push(id);
      }
      return pending;
    }

    for (let i = 0; i < deviceIds.length; i += SMISMEMBER_CHUNK_SIZE) {
      const chunk = deviceIds.slice(i, i + SMISMEMBER_CHUNK_SIZE);
      const flags = await client.smIsMember(key, chunk);
      for (let j = 0; j < chunk.length; j++) {
        if (flags[j]) pending.push(chunk[j]);
      }
    }
    return pending;
  }

  async isDelivered(deviceId: string, version: string): Promise<boolean> {
    const client = this.getClient();
    if (!client) return false;
    return Boolean(await client.sIsMember(this.deliveredKey(version), deviceId));
  }

  async markDelivered(deviceId: string, version: string): Promise<void> {
    const client = this.getClient();
    if (!client) return;
    const multi = client.multi();
    multi.sRem(this.pendingKey(version), deviceId);
    multi.sAdd(this.deliveredKey(version), deviceId);
    multi.expire(this.deliveredKey(version), 2592000);
    await multi.exec();
  }

  async markPending(deviceId: string, version: string): Promise<void> {
    const client = this.getClient();
    if (!client) return;
    const multi = client.multi();
    multi.sAdd(this.pendingKey(version), deviceId);
    multi.expire(this.pendingKey(version), 2592000);
    await multi.exec();
  }

  /** Returns true if this is the first attempt recorded for device in this stage. */
  async markStageAttempted(
    version: string,
    percentage: number,
    deviceId: string
  ): Promise<boolean> {
    const client = this.getClient();
    if (!client) return true;
    const key = this.stageAttemptedKey(version, percentage);
    const multi = client.multi();
    multi.sAdd(key, deviceId);
    multi.expire(key, 2592000);
    const res = await multi.exec();
    const added = Array.isArray(res) ? res[0] : undefined;
    return Number(added) === 1;
  }

  async clearStageAttempted(version: string, percentage: number): Promise<void> {
    const client = this.getClient();
    if (!client) return;
    await client.del(this.stageAttemptedKey(version, percentage));
  }

  /** Returns true if we should emit OTA_CATCHUP_DEFERRED (first time in 24h). */
  async shouldLogCatchupDeferred(deviceId: string): Promise<boolean> {
    const client = this.getClient();
    if (!client) return true;
    const key = this.deferredLogKey(deviceId);
    const set = await client.set(key, String(Date.now()), { NX: true, EX: 86400 });
    return set === 'OK';
  }

  async tryAcquireSchedulerLock(ttlSec: number): Promise<boolean> {
    const client = this.getClient();
    if (!client) return true;
    const set = await client.set(this.schedulerLockKey(), '1', { NX: true, EX: ttlSec });
    return set === 'OK';
  }

  async releaseSchedulerLock(): Promise<void> {
    const client = this.getClient();
    if (!client) return;
    await client.del(this.schedulerLockKey());
  }

  async markSchedulerRun(now = new Date()): Promise<void> {
    const client = this.getClient();
    if (!client) return;
    await client.set(this.schedulerLastRunKey(), now.toISOString());
  }

  async getSchedulerLastRun(): Promise<Date | null> {
    const client = this.getClient();
    if (!client) return null;
    const raw = await client.get(this.schedulerLastRunKey());
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
}

// ─── OTA Command Publisher ───────────────────────────────────────────────

export interface OtaUpdateCommandPayload {
  cmd: 'ota_update';
  version: string;
  rollout: { strategy: string; percentage: number };
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
      rollout: offer.rollout || { strategy: 'percentage', percentage: 100 },
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
      rollout: offer.rollout || { strategy: 'percentage', percentage: 100 },
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
  rollout?: { strategy: string; percentage: number };
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
  /** @deprecated Ignored — rollout is the sole push authority. */
  broadcast?: boolean;
  rollout?: {
    strategy?: string;
    percentage?: number;
    deviceIds?: string[];
  };
}

export type OtaReleaseWebhookResult =
  | { ok: true; version: string; created: boolean; currentPercentage: number }
  | { ok: false; httpStatus: number; code: string; error: string };

export type OtaAdvanceResult =
  | { ok: true; version: string; currentPercentage: number; previousPercentage: number }
  | { ok: false; httpStatus: number; code: string; error: string };

export type OtaRolloutStatus = {
  version: string;
  current_percentage: number;
  aborted: boolean;
  can_advance: boolean;
  next_percentage: number | null;
  stage_started_at: string | null;
  stage_stats: {
    attempted: number;
    failed: number;
    rolled_back: number;
    failure_rate: number;
    min_sample_reached: boolean;
  };
};

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
    const releases = await FirmwareRelease.find({
      status: FirmwareReleaseStatus.STABLE,
      aborted: { $ne: true }
    })
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

  private parseRolloutInput(
    input: OtaReleaseWebhookInput
  ): { rollout: IFirmwareRollout; percentage: number } {
    if (input.broadcast === true) {
      const pct = input.rollout?.percentage ?? 1;
      if (pct < 100) {
        logger.warn('[OTA] broadcast:true ignored — rollout.percentage governs push', {
          percentage: pct
        });
      }
    }

    const strategyRaw = (input.rollout?.strategy || 'percentage').toLowerCase();
    const strategy =
      strategyRaw === FirmwareRolloutStrategy.ALLOWLIST
        ? FirmwareRolloutStrategy.ALLOWLIST
        : strategyRaw === FirmwareRolloutStrategy.ALL
          ? FirmwareRolloutStrategy.ALL
          : FirmwareRolloutStrategy.PERCENTAGE;

    let percentage = input.rollout?.percentage;
    if (percentage == null || !Number.isFinite(percentage)) {
      percentage = 1;
    }
    percentage = Math.max(0, Math.min(100, Math.floor(percentage)));

    const deviceIds = Array.isArray(input.rollout?.deviceIds)
      ? input.rollout!.deviceIds!.map(String).filter(Boolean)
      : [];

    return {
      percentage,
      rollout: {
        strategy,
        percentage,
        deviceIds
      }
    };
  }

  async ingestRelease(input: OtaReleaseWebhookInput): Promise<OtaReleaseWebhookResult> {
    const version = input.version.trim();
    const objectKey = input.objectKey.trim();
    const sha256 = input.sha256.trim().toLowerCase();
    const signature = input.signature.trim();
    const { rollout, percentage } = this.parseRolloutInput(input);

    if (!version || !objectKey || !sha256 || !signature) {
      return {
        ok: false,
        httpStatus: 400,
        code: 'MISSING_FIELDS',
        error: 'version, object_key, sha256, and signature are required'
      };
    }

    if (!this.commandPublisher) {
      return {
        ok: false,
        httpStatus: 503,
        code: 'MQTT_NOT_READY',
        error: 'OTA command publisher is not configured'
      };
    }

    const existingHard = await FirmwareRelease.findOne({
      version,
      status: FirmwareReleaseStatus.DEPRECATED
    });
    if (existingHard) {
      return {
        ok: false,
        httpStatus: 409,
        code: 'RELEASE_DEPRECATED',
        error: `Version ${version} is DEPRECATED and cannot be re-promoted via webhook`
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
      const now = new Date();

      const previousActive = this.otaRedisState
        ? await this.otaRedisState.getActiveRelease()
        : null;
      let previousVersion = previousActive?.version;
      if (!previousVersion) {
        const latestStable = await FirmwareRelease.findOne({
          status: FirmwareReleaseStatus.STABLE,
          aborted: { $ne: true },
          version: { $ne: version }
        })
          .sort({ releasedAt: -1, createdAt: -1 })
          .select({ version: 1 })
          .lean();
        previousVersion = latestStable?.version;
      }

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
          rollout,
          currentPercentage: percentage,
          stageStartedAt: now,
          stageAttemptedCount: 0,
          stageFailedCount: 0,
          stageRolledBackCount: 0,
          aborted: false,
          previousVersion: previousVersion || undefined,
          releasedAt: input.releasedAt ? new Date(input.releasedAt) : now,
          createdBy: 'ota-release-webhook'
        },
        { upsert: true, new: true }
      );

      void getAuditService()
        ?.logEvent({
          event: AuditEventType.OTA_RELEASE_PROMOTED,
          details: { version, objectKey, source: 'webhook', created, percentage }
        })
        .catch(() => undefined);

      const releasedAtIso = input.releasedAt || now.toISOString();

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
        await this.otaRedisState.clearStageAttempted(version, percentage);

        const eligibleIds = await this.listRolloutEligibleDeviceIds(release);
        await this.otaRedisState.seedPendingFleet(release.version, eligibleIds);
      }

      void getOtaReleaseLog()?.addEntry(version, sha256, objectKey, keyFingerprint, input.releasedAt ? new Date(input.releasedAt) : undefined).catch(() => undefined);

      const pushedCount = await this.pushReleaseToOnlineDevices(release.version);

      void getAuditService()
        ?.logEvent({
          event: AuditEventType.OTA_PUSH_SENT,
          details: {
            version,
            target: 'device',
            mode: 'full',
            source: 'webhook',
            pushedCount,
            percentage
          }
        })
        .catch(() => undefined);

      logger.info('[OTA] Release ingested from CI webhook', {
        version,
        objectKey,
        pushedCount,
        created,
        percentage
      });

      return { ok: true, version, created, currentPercentage: percentage };
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

  async advanceRollout(version: string, targetPercentage?: number): Promise<OtaAdvanceResult> {
    const release = await FirmwareRelease.findOne({ version });
    if (!release) {
      return { ok: false, httpStatus: 404, code: 'RELEASE_NOT_FOUND', error: 'Release not found' };
    }
    if (release.aborted || release.status === FirmwareReleaseStatus.DEPRECATED) {
      return {
        ok: false,
        httpStatus: 409,
        code: 'ROLLOUT_ABORTED',
        error: `Rollout for ${version} is aborted`
      };
    }
    if (release.status !== FirmwareReleaseStatus.STABLE) {
      return {
        ok: false,
        httpStatus: 409,
        code: 'RELEASE_NOT_STABLE',
        error: 'Only STABLE releases can be advanced'
      };
    }

    const previousPercentage = release.currentPercentage ?? release.rollout?.percentage ?? 1;
    const next =
      targetPercentage != null
        ? targetPercentage
        : nextRolloutPercentage(previousPercentage);

    if (next == null) {
      return {
        ok: false,
        httpStatus: 400,
        code: 'ROLLOUT_COMPLETE',
        error: 'Rollout already at 100%'
      };
    }
    if (!isValidRolloutStep(next)) {
      return {
        ok: false,
        httpStatus: 400,
        code: 'INVALID_PERCENTAGE',
        error: 'percentage must be one of 1, 10, 50, 100'
      };
    }
    if (next <= previousPercentage) {
      return {
        ok: false,
        httpStatus: 400,
        code: 'NON_MONOTONIC',
        error: `percentage must increase (current ${previousPercentage}, requested ${next})`
      };
    }
    const expected = nextRolloutPercentage(previousPercentage);
    if (expected != null && next !== expected) {
      return {
        ok: false,
        httpStatus: 400,
        code: 'INVALID_STEP',
        error: `Next allowed percentage is ${expected}`
      };
    }

    const now = new Date();
    release.currentPercentage = next;
    release.rollout = {
      ...(release.rollout || { strategy: FirmwareRolloutStrategy.PERCENTAGE }),
      strategy: FirmwareRolloutStrategy.PERCENTAGE,
      percentage: next,
      deviceIds: release.rollout?.deviceIds || []
    };
    release.stageStartedAt = now;
    release.stageAttemptedCount = 0;
    release.stageFailedCount = 0;
    release.stageRolledBackCount = 0;
    await release.save();

    await this.otaRedisState?.clearStageAttempted(version, next);
    const eligibleIds = await this.listRolloutEligibleDeviceIds(release);
    await this.otaRedisState?.addPendingDevices(version, eligibleIds);

    const pushedCount = await this.pushReleaseToOnlineDevices(version);

    void sendOtaSlackAlert({
      kind: 'advance',
      version,
      percentage: next
    }).catch(() => undefined);

    logger.info('[OTA] Rollout advanced', {
      version,
      previousPercentage,
      next,
      pushedCount
    });

    return { ok: true, version, currentPercentage: next, previousPercentage };
  }

  async abortRollout(
    version: string,
    reason = 'failure_rate'
  ): Promise<{ ok: true } | { ok: false; httpStatus: number; code: string; error: string }> {
    const release = await FirmwareRelease.findOne({ version });
    if (!release) {
      return { ok: false, httpStatus: 404, code: 'RELEASE_NOT_FOUND', error: 'Release not found' };
    }

    const attempted = release.stageAttemptedCount || 0;
    const failed = release.stageFailedCount || 0;
    const rolledBack = release.stageRolledBackCount || 0;
    const failureRate = stageFailureRate(attempted, failed, rolledBack);

    release.status = FirmwareReleaseStatus.DEPRECATED;
    release.aborted = true;
    await release.save();

    await this.otaRedisState?.clearPendingFleet(version);
    await this.restorePreviousActiveRelease(release);

    void sendOtaSlackAlert({
      kind: 'abort',
      version,
      failureRate,
      attempted,
      failed,
      rolledBack,
      percentage: release.currentPercentage,
      message: reason
    }).catch(() => undefined);

    logger.warn('[OTA] Rollout aborted', { version, reason, failureRate, attempted, failed, rolledBack });
    return { ok: true };
  }

  async haltRollout(version: string): Promise<
    { ok: true } | { ok: false; httpStatus: number; code: string; error: string }
  > {
    return this.abortRollout(version, 'halt');
  }

  async retryDeprecatedRelease(version: string): Promise<
    { ok: true; status: string } | { ok: false; httpStatus: number; code: string; error: string }
  > {
    const release = await FirmwareRelease.findOne({ version });
    if (!release) {
      return { ok: false, httpStatus: 404, code: 'RELEASE_NOT_FOUND', error: 'Release not found' };
    }
    if (release.status === FirmwareReleaseStatus.DEPRECATED) {
      return {
        ok: false,
        httpStatus: 409,
        code: 'NOT_RETRYABLE',
        error: 'Hard DEPRECATED cannot be retried — mark deprecated_retryable first or ship a new version'
      };
    }
    if (release.status !== FirmwareReleaseStatus.DEPRECATED_RETRYABLE) {
      return {
        ok: false,
        httpStatus: 409,
        code: 'INVALID_STATUS',
        error: 'Only DEPRECATED_RETRYABLE releases can be reset to STABLE'
      };
    }

    release.status = FirmwareReleaseStatus.STABLE;
    release.aborted = false;
    release.stageStartedAt = new Date();
    release.stageAttemptedCount = 0;
    release.stageFailedCount = 0;
    release.stageRolledBackCount = 0;
    await release.save();

    return { ok: true, status: FirmwareReleaseStatus.STABLE };
  }

  async markDeprecatedRetryable(version: string): Promise<
    { ok: true } | { ok: false; httpStatus: number; code: string; error: string }
  > {
    const release = await FirmwareRelease.findOne({ version });
    if (!release) {
      return { ok: false, httpStatus: 404, code: 'RELEASE_NOT_FOUND', error: 'Release not found' };
    }
    if (release.status !== FirmwareReleaseStatus.DEPRECATED && !release.aborted) {
      return {
        ok: false,
        httpStatus: 409,
        code: 'INVALID_STATUS',
        error: 'Only aborted/DEPRECATED releases can become DEPRECATED_RETRYABLE'
      };
    }
    release.status = FirmwareReleaseStatus.DEPRECATED_RETRYABLE;
    await release.save();
    return { ok: true };
  }

  private async restorePreviousActiveRelease(aborted: IFirmwareRelease): Promise<void> {
    if (!this.otaRedisState) return;

    const active = await this.otaRedisState.getActiveRelease();
    if (active && active.version !== aborted.version) {
      return;
    }

    const prevVersion = aborted.previousVersion;
    if (!prevVersion) {
      await this.otaRedisState.clearActiveRelease();
      return;
    }

    const prev = await FirmwareRelease.findOne({ version: prevVersion });
    const keyFingerprint = this.otaConfig.signingPublicKeyPem
      ? computeSigningKeyFingerprint(this.otaConfig.signingPublicKeyPem)
      : undefined;

    let restored: OtaActiveRelease | null = null;
    if (prev) {
      restored = {
        version: prev.version,
        sha256: prev.sha256,
        signature: prev.signature,
        objectKey: prev.objectKey || prev.s3Key || '',
        sizeBytes: prev.sizeBytes,
        releasedAt: (prev.releasedAt || prev.createdAt || new Date()).toISOString(),
        keyFingerprint
      };
    } else {
      const cached = await this.otaRedisState.getPreviousActiveRelease();
      if (cached?.version === prevVersion) restored = cached;
    }

    await this.otaRedisState.clearActiveRelease();
    if (restored) {
      await this.otaRedisState.forceSetActiveRelease(restored);
    }
  }

  getRolloutStatus(release: IFirmwareRelease): OtaRolloutStatus {
    const attempted = release.stageAttemptedCount || 0;
    const failed = release.stageFailedCount || 0;
    const rolledBack = release.stageRolledBackCount || 0;
    const currentPercentage = release.currentPercentage ?? release.rollout?.percentage ?? 100;
    const can_advance = canAdvanceStage({
      aborted: Boolean(release.aborted),
      currentPercentage,
      stageStartedAt: release.stageStartedAt,
      attempted,
      failed,
      rolledBack,
      minHours: this.otaConfig.stageMinHours,
      minSample: this.otaConfig.stageAbortMinSample,
      maxFailureRate: this.otaConfig.stageAbortFailureRate
    });

    return {
      version: release.version,
      current_percentage: currentPercentage,
      aborted: Boolean(release.aborted),
      can_advance,
      next_percentage: nextRolloutPercentage(currentPercentage),
      stage_started_at: release.stageStartedAt
        ? new Date(release.stageStartedAt).toISOString()
        : null,
      stage_stats: {
        attempted,
        failed,
        rolled_back: rolledBack,
        failure_rate: stageFailureRate(attempted, failed, rolledBack),
        min_sample_reached: attempted >= this.otaConfig.stageAbortMinSample
      }
    };
  }

  async getActiveReleaseForAdmin(): Promise<IFirmwareRelease | null> {
    const inProgress = await FirmwareRelease.findOne({
      status: FirmwareReleaseStatus.STABLE,
      aborted: { $ne: true },
      currentPercentage: { $lt: 100 }
    }).sort({ releasedAt: -1, createdAt: -1 });
    if (inProgress) return inProgress;

    return FirmwareRelease.findOne({ status: FirmwareReleaseStatus.STABLE }).sort({
      releasedAt: -1,
      createdAt: -1
    });
  }

  async deliverPendingToDevice(deviceId: string, currentVersion: string): Promise<void> {
    if (!this.commandPublisher || !this.otaRedisState) return;

    const active = await this.otaRedisState.getActiveRelease();
    if (!active) return;
    if (!isVersionGreater(active.version, currentVersion)) return;
    if (await this.otaRedisState.isDelivered(deviceId, active.version)) return;

    const device = await Device.findOne({ clientId: deviceId });
    if (!device || !this.isDeviceEligible(device)) return;

    const blocked = new Set(device.otaBlockedVersions || []);
    if (blocked.has(active.version)) return;

    const release = await FirmwareRelease.findOne({
      version: active.version,
      status: FirmwareReleaseStatus.STABLE,
      aborted: { $ne: true }
    });
    if (!release) {
      logger.warn('[OTA] Active release missing from DB', { version: active.version, deviceId });
      return;
    }

    if (!this.matchesRollout(release, device, deviceId)) {
      if (await this.otaRedisState.shouldLogCatchupDeferred(deviceId)) {
        logger.info('OTA_CATCHUP_DEFERRED', {
          deviceId,
          version: active.version,
          currentPercentage: release.currentPercentage,
          bucket: deviceHashBucket(deviceId)
        });
      }
      return;
    }

    if (!(await this.otaRedisState.isPending(deviceId, active.version))) {
      await this.otaRedisState.markPending(deviceId, active.version);
    }

    const offer = await this.buildOffer(release);
    if (!offer) return;

    await this.commandPublisher.publishUpdateToDevice(deviceId, offer, false);
    await this.recordStageAttempt(release, deviceId);
  }

  async getLatestStableOffer(deviceId: string): Promise<OtaUpdateOffer | null> {
    const device = await Device.findOne({ clientId: deviceId });
    if (!device || !this.isDeviceEligible(device)) return null;

    const release = await FirmwareRelease.findOne({
      status: FirmwareReleaseStatus.STABLE,
      aborted: { $ne: true }
    }).sort({ releasedAt: -1, createdAt: -1 });

    if (!release) return null;

    return this.buildOffer(release);
  }

  /** TEST_OTA only: latest STABLE offer with no device eligibility / rollout gates. */
  async getLatestStableOfferUngated(): Promise<OtaUpdateOffer | null> {
    const release = await FirmwareRelease.findOne({ status: FirmwareReleaseStatus.STABLE }).sort({
      releasedAt: -1,
      createdAt: -1
    });
    if (!release) return null;
    return this.buildOffer(release);
  }

  private async listRolloutEligibleDeviceIds(release: IFirmwareRelease): Promise<string[]> {
    const devices = await Device.find({
      status: { $in: [DeviceStatus.PROVISIONED, DeviceStatus.ACTIVE, DeviceStatus.OFFLINE] }
    }).select({ clientId: 1, userId: 1, status: 1, otaBlockedVersions: 1 });

    const out: string[] = [];
    for (const device of devices) {
      const id = device.clientId;
      if (!id) continue;
      if ((device.otaBlockedVersions || []).includes(release.version)) continue;
      if (this.matchesRollout(release, device, id)) {
        out.push(id);
      }
    }
    return out;
  }

  private async pushReleaseToOnlineDevices(version: string): Promise<number> {
    if (!this.commandPublisher) return 0;

    const release = await FirmwareRelease.findOne({
      version,
      status: FirmwareReleaseStatus.STABLE,
      aborted: { $ne: true }
    });
    if (!release) return 0;

    const online = await getActiveDeviceCache().getAllActive();
    const onlineIds = online.map((d) => d.deviceId);

    const candidates = this.otaRedisState
      ? await this.otaRedisState.filterPending(version, onlineIds)
      : onlineIds;

    let pushed = 0;
    await mapPool(candidates, this.otaConfig.mqttPushConcurrency || 100, async (deviceId) => {
      const device = await Device.findOne({ clientId: deviceId });
      const currentVersion = device?.firmwareVersion || '0.0.0';
      if (!device || !this.isDeviceEligible(device)) return;
      if ((device.otaBlockedVersions || []).includes(version)) return;
      if (!this.matchesRollout(release, device, deviceId)) return;
      if (!isVersionGreater(version, currentVersion) && currentVersion !== version) {
        // still offer if behind
      }
      if (!isVersionGreater(version, currentVersion)) return;

      const offer = await this.buildOffer(release);
      if (!offer) return;

      await this.commandPublisher!.publishUpdateToDevice(deviceId, offer, false);
      await this.recordStageAttempt(release, deviceId);
      pushed++;
    });

    return pushed;
  }

  private async recordStageAttempt(release: IFirmwareRelease, deviceId: string): Promise<void> {
    const pct = release.currentPercentage ?? release.rollout?.percentage ?? 100;
    const first = await this.otaRedisState?.markStageAttempted(release.version, pct, deviceId);
    if (first === false) return;

    await FirmwareRelease.updateOne(
      { version: release.version },
      { $inc: { stageAttemptedCount: 1 } }
    );
    release.stageAttemptedCount = (release.stageAttemptedCount || 0) + 1;
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

  matchesRollout(release: IFirmwareRelease, device: IDevice, deviceId: string): boolean {
    const rollout = release.rollout || { strategy: FirmwareRolloutStrategy.ALL };
    const blocked = rollout.blockedDeviceIds || [];
    if (blocked.includes(deviceId)) {
      return false;
    }

    const pct =
      release.currentPercentage ??
      rollout.percentage ??
      (rollout.strategy === FirmwareRolloutStrategy.ALL ? 100 : 0);
    const allowlist = rollout.deviceIds || [];

    switch (rollout.strategy) {
      case FirmwareRolloutStrategy.ALLOWLIST: {
        if (allowlist.length === 0) return false;
        return allowlist.includes(deviceId);
      }
      case FirmwareRolloutStrategy.PERCENTAGE: {
        if (pct >= 100) return true;
        if (allowlist.includes(deviceId)) return true;
        return deviceHashBucket(deviceId) < pct;
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

  private async buildOffer(release: IFirmwareRelease): Promise<OtaUpdateOffer | null> {
    try {
      const expiresAt = new Date(Date.now() + this.otaConfig.presignedUrlTtlSec * 1000);
      const downloadUrl = await buildOtaMqttDownloadUrl(release, this.otaConfig, this.storage);
      const keyFingerprint = this.otaConfig.signingPublicKeyPem
        ? computeSigningKeyFingerprint(this.otaConfig.signingPublicKeyPem)
        : undefined;
      const percentage =
        release.currentPercentage ?? release.rollout?.percentage ?? 100;
      const strategy = release.rollout?.strategy || FirmwareRolloutStrategy.PERCENTAGE;

      return {
        version: release.version,
        downloadUrl,
        sha256: release.sha256,
        signature: release.signature,
        sizeBytes: release.sizeBytes,
        expiresAt: expiresAt.toISOString(),
        keyFingerprint,
        track: 'pilot',
        rollout: { strategy, percentage }
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
    const kind = classifyOtaReason(reason);
    if (kind === 'track_mismatch') {
      return { blocked: false, failures: 0 };
    }

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

    const threshold = this.otaConfig.rollbackFailureThreshold;
    const permanent = kind === 'permanent';
    const transientStrikeOut = kind === 'transient' && next >= threshold;
    const unknownStrikeOut = kind === 'unknown' && next >= threshold;
    let blocked = false;

    if (permanent || transientStrikeOut || unknownStrikeOut) {
      const blockedVersions = new Set(device.otaBlockedVersions || []);
      blockedVersions.add(version);
      device.otaBlockedVersions = Array.from(blockedVersions);
      blocked = true;

      void getAuditService()
        ?.logEvent({
          event: AuditEventType.OTA_DEVICE_BLOCKED,
          deviceId,
          details: { version, failures: next, threshold, reason, kind }
        })
        .catch(() => undefined);
    }

    if (reason) {
      device.errorMessage = `OTA rollback ${version}: ${reason}`.slice(0, 500);
    }

    await device.save();

    const incFailed = shouldIncrementFailed(kind, reason);
    const incRolled = shouldIncrementRolledBack(kind, reason);
    if (incFailed || incRolled) {
      const update: Record<string, number> = {};
      if (incFailed) update.stageFailedCount = 1;
      if (incRolled) update.stageRolledBackCount = 1;
      await FirmwareRelease.updateOne({ version, aborted: { $ne: true } }, { $inc: update });

      const release = await FirmwareRelease.findOne({ version });
      if (release && !release.aborted) {
        const attempted = release.stageAttemptedCount || 0;
        const failed = release.stageFailedCount || 0;
        const rolledBack = release.stageRolledBackCount || 0;
        if (
          shouldAbortStage(
            attempted,
            failed,
            rolledBack,
            this.otaConfig.stageAbortMinSample,
            this.otaConfig.stageAbortFailureRate
          )
        ) {
          await this.abortRollout(version, 'failure_rate');
        }
      }
    }

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
  async maybeRecordImplicitOtaSuccess(
    deviceId: string,
    fwVersion: string,
    bootType?: string
  ): Promise<void> {
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
        details: {
          version: fwVersion,
          implicit: true,
          bootType: bootType || undefined,
          previousFirmwareVersion: device?.firmwareVersion
        }
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

export { deviceHashBucket };
