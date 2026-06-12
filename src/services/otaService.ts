/**
 * OTA update resolution, rollout gating, and device state updates.
 */

import * as crypto from 'crypto';
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
import type { FirmwareStorageService } from './firmwareStorageService';

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

export class OtaService {
  constructor(
    private readonly otaConfig: OtaConfig,
    private readonly storage: FirmwareStorageService,
    private readonly publicBaseUrl: string
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
        downloadUrl = await this.storage.createPresignedGetUrl(release.s3Key);
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
