/**
 * Admin OTA routes — release management and fleet push.
 */

import { Router, Request, Response } from 'express';
import type { OtaConfig } from '../config';
import { AuthService } from '../services/authService';
import {
  FirmwareRelease,
  FirmwareReleaseStatus,
  FirmwareRolloutStrategy,
  type IFirmwareRollout
} from '../models/FirmwareRelease';
import { Device } from '../models/Device';
import type { FirmwareStorageService } from '../services/firmwareStorageService';
import type { OtaCommandPublisher } from '../services/otaCommandPublisher';
import type { OtaService } from '../services/otaService';
import { AuditEventType, getAuditService } from '../services/auditService';
import { logger } from '../utils/logger';

export interface OtaAdminRoutesDeps {
  otaConfig: OtaConfig;
  authService: AuthService;
  storage: FirmwareStorageService;
  otaService: OtaService;
  commandPublisher: OtaCommandPublisher;
}

async function requireAdminAuth(
  req: Request,
  res: Response,
  authService: AuthService
): Promise<{ userId: string } | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      error: 'Authorization required',
      code: 'AUTH_TOKEN_MISSING',
      timestamp: new Date().toISOString()
    });
    return null;
  }

  const token = authHeader.substring(7);
  const result = await authService.verifyAuthToken(token);
  if (!result.valid || !result.userId) {
    res.status(401).json({
      success: false,
      error: result.error || 'Invalid token',
      code: 'AUTH_TOKEN_INVALID',
      timestamp: new Date().toISOString()
    });
    return null;
  }

  return { userId: result.userId };
}

export function createOtaAdminRoutes(deps: OtaAdminRoutesDeps): Router {
  const router = Router();
  const { otaConfig, authService, storage, otaService, commandPublisher } = deps;

  router.post('/releases/init', async (req: Request, res: Response) => {
    const auth = await requireAdminAuth(req, res, authService);
    if (!auth) return;

    const version = String(req.body?.version || '').trim();
    if (!version) {
      res.status(400).json({
        success: false,
        error: 'version is required',
        code: 'MISSING_VERSION',
        timestamp: new Date().toISOString()
      });
      return;
    }

    const existing = await FirmwareRelease.findOne({ version });
    if (existing) {
      res.status(409).json({
        success: false,
        error: 'Version already exists',
        code: 'VERSION_EXISTS',
        timestamp: new Date().toISOString()
      });
      return;
    }

    const s3Key = storage.buildS3Key(version);
    const uploadUrl = await storage.createPresignedPutUrl(s3Key, version);

    res.json({
      success: true,
      version,
      s3_key: s3Key,
      upload_url: uploadUrl,
      upload_metadata: {
        'x-amz-meta-firmware-version': version
      },
      expires_in: otaConfig.presignedUrlTtlSec,
      timestamp: new Date().toISOString()
    });
  });

  router.post('/releases/finalize', async (req: Request, res: Response) => {
    const auth = await requireAdminAuth(req, res, authService);
    if (!auth) return;

    const version = String(req.body?.version || '').trim();
    const sha256 = String(req.body?.sha256 || '').trim().toLowerCase();
    const signature = String(req.body?.signature || '').trim();
    const s3Key = String(req.body?.s3_key || req.body?.s3Key || '').trim();
    const rollout = (req.body?.rollout || { strategy: FirmwareRolloutStrategy.ALL }) as IFirmwareRollout;

    if (!version || !sha256 || !signature || !s3Key) {
      res.status(400).json({
        success: false,
        error: 'version, sha256, signature, and s3_key are required',
        code: 'MISSING_FIELDS',
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      res.status(400).json({
        success: false,
        error: 'sha256 must be 64 hex characters',
        code: 'INVALID_SHA256',
        timestamp: new Date().toISOString()
      });
      return;
    }

    try {
      const head = await storage.headObject(s3Key);
      if (!head.sizeBytes) {
        res.status(404).json({
          success: false,
          error: 'S3 object not found',
          code: 'S3_NOT_FOUND',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const shaOk = await storage.verifySha256(s3Key, sha256);
      if (!shaOk) {
        res.status(400).json({
          success: false,
          error: 'sha256 does not match S3 object',
          code: 'SHA256_MISMATCH',
          timestamp: new Date().toISOString()
        });
        return;
      }

      await storage.ensureFirmwareMetadata(s3Key, version, sha256);

      const release = await FirmwareRelease.findOneAndUpdate(
        { version },
        {
          version,
          sha256,
          signature,
          s3Key,
          sizeBytes: head.sizeBytes,
          status: FirmwareReleaseStatus.DRAFT,
          rollout,
          createdBy: auth.userId
        },
        { upsert: true, new: true }
      );

      void getAuditService()
        ?.logEvent({
          event: AuditEventType.OTA_RELEASE_CREATED,
          userId: auth.userId,
          details: { version, s3Key, sizeBytes: head.sizeBytes }
        })
        .catch(() => undefined);

      res.json({
        success: true,
        release: {
          version: release.version,
          status: release.status,
          size_bytes: release.sizeBytes
        },
        timestamp: new Date().toISOString()
      });
    } catch (err: unknown) {
      logger.error('[OTA] finalize failed', {
        error: err instanceof Error ? err.message : String(err)
      });
      res.status(500).json({
        success: false,
        error: 'Finalize failed',
        code: 'FINALIZE_ERROR',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.post('/releases/:version/promote', async (req: Request, res: Response) => {
    const auth = await requireAdminAuth(req, res, authService);
    if (!auth) return;

    if (!otaConfig.signingConfirmed) {
      res.status(503).json({
        success: false,
        error: 'OTA signing format not confirmed — set OTA_SIGNING_CONFIRMED=true after firmware team sign-off',
        code: 'SIGNING_NOT_CONFIRMED',
        timestamp: new Date().toISOString()
      });
      return;
    }

    const version = decodeURIComponent(req.params.version);
    const release = await FirmwareRelease.findOne({ version, status: FirmwareReleaseStatus.DRAFT });
    if (!release) {
      res.status(404).json({
        success: false,
        error: 'Draft release not found',
        code: 'DRAFT_NOT_FOUND',
        timestamp: new Date().toISOString()
      });
      return;
    }

    try {
      const head = await storage.headObject(release.s3Key);
      if (head.firmwareVersion !== release.version) {
        await storage.ensureFirmwareMetadata(release.s3Key, release.version, release.sha256);
      }

      release.status = FirmwareReleaseStatus.STABLE;
      release.releasedAt = new Date();
      await release.save();

      void getAuditService()
        ?.logEvent({
          event: AuditEventType.OTA_RELEASE_PROMOTED,
          userId: auth.userId,
          details: { version }
        })
        .catch(() => undefined);

      res.json({
        success: true,
        version: release.version,
        status: release.status,
        released_at: release.releasedAt?.toISOString(),
        timestamp: new Date().toISOString()
      });
    } catch (err: unknown) {
      logger.error('[OTA] promote failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({
        success: false,
        error: 'Promote failed',
        code: 'PROMOTE_ERROR',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.get('/releases', async (req: Request, res: Response) => {
    const auth = await requireAdminAuth(req, res, authService);
    if (!auth) return;

    const limit = Math.min(parseInt(String(req.query.limit || '20'), 10) || 20, 100);
    const skip = parseInt(String(req.query.skip || '0'), 10) || 0;

    const [items, total] = await Promise.all([
      FirmwareRelease.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      FirmwareRelease.countDocuments()
    ]);

    res.json({
      success: true,
      total,
      skip,
      limit,
      releases: items.map((r) => ({
        version: r.version,
        status: r.status,
        size_bytes: r.sizeBytes,
        released_at: r.releasedAt,
        created_at: r.createdAt
      })),
      timestamp: new Date().toISOString()
    });
  });

  router.get('/devices/:deviceId/ota', async (req: Request, res: Response) => {
    const auth = await requireAdminAuth(req, res, authService);
    if (!auth) return;

    const deviceId = decodeURIComponent(req.params.deviceId);
    const device = await Device.findOne({ clientId: deviceId }).lean();
    if (!device) {
      res.status(404).json({
        success: false,
        error: 'Device not found',
        code: 'DEVICE_NOT_FOUND',
        timestamp: new Date().toISOString()
      });
      return;
    }

    res.json({
      success: true,
      device_id: deviceId,
      firmware_version: device.firmwareVersion,
      firmware_reported_at: device.firmwareReportedAt,
      ota_last_check_at: device.otaLastCheckAt,
      ota_state: device.otaState,
      ota_target_version: device.otaTargetVersion,
      ota_blocked_versions: device.otaBlockedVersions || [],
      timestamp: new Date().toISOString()
    });
  });

  router.post('/push', async (req: Request, res: Response) => {
    const auth = await requireAdminAuth(req, res, authService);
    if (!auth) return;

    const version = String(req.body?.version || '').trim();
    const target = String(req.body?.target || 'device');
    const mode = String(req.body?.mode || 'full') as 'full' | 'trigger';
    const force = req.body?.force === true;
    const deviceIds: string[] = Array.isArray(req.body?.deviceIds)
      ? req.body.deviceIds.map(String)
      : req.body?.device_id
        ? [String(req.body.device_id)]
        : [];

    if (!version) {
      res.status(400).json({
        success: false,
        error: 'version is required',
        code: 'MISSING_VERSION',
        timestamp: new Date().toISOString()
      });
      return;
    }

    const release = await FirmwareRelease.findOne({
      version,
      status: FirmwareReleaseStatus.STABLE
    });
    if (!release && mode === 'full') {
      res.status(404).json({
        success: false,
        error: 'Stable release not found',
        code: 'RELEASE_NOT_FOUND',
        timestamp: new Date().toISOString()
      });
      return;
    }

    try {
      if (target === 'broadcast') {
        if (mode === 'trigger') {
          res.status(400).json({
            success: false,
            error: 'Broadcast trigger not supported — use full mode',
            code: 'INVALID_BROADCAST_MODE',
            timestamp: new Date().toISOString()
          });
          return;
        }
        if (!release) {
          res.status(404).json({
            success: false,
            error: 'Stable release not found',
            code: 'RELEASE_NOT_FOUND',
            timestamp: new Date().toISOString()
          });
          return;
        }
        const downloadUrl =
          otaConfig.downloadMode === 'proxy'
            ? `${req.protocol}://${req.get('host')}/api/v1/ota/download/${encodeURIComponent(version)}`
            : await storage.createPresignedGetUrl(release.s3Key);
        const expiresAt = new Date(Date.now() + otaConfig.presignedUrlTtlSec * 1000);
        await commandPublisher.publishBroadcastUpdate(
          {
            version: release.version,
            downloadUrl,
            sha256: release.sha256,
            signature: release.signature,
            sizeBytes: release.sizeBytes,
            expiresAt: expiresAt.toISOString()
          },
          force
        );
      } else {
        if (deviceIds.length === 0) {
          res.status(400).json({
            success: false,
            error: 'deviceIds required for device target',
            code: 'MISSING_DEVICE_IDS',
            timestamp: new Date().toISOString()
          });
          return;
        }

        for (const deviceId of deviceIds) {
          if (mode === 'trigger') {
            await commandPublisher.publishCheckTrigger(deviceId, version, force);
          } else {
            const device = await Device.findOne({ clientId: deviceId });
            const current = device?.firmwareVersion || '0.0.0';
            const offer = await otaService.resolveUpdate({
              deviceId,
              currentVersion: current
            });
            if (offer && offer.version === version) {
              await commandPublisher.publishUpdateToDevice(deviceId, offer, force);
            } else if (release) {
              const downloadUrl =
                otaConfig.downloadMode === 'proxy'
                  ? `${req.protocol}://${req.get('host')}/api/v1/ota/download/${encodeURIComponent(version)}`
                  : await storage.createPresignedGetUrl(release.s3Key);
              const expiresAt = new Date(Date.now() + otaConfig.presignedUrlTtlSec * 1000);
              await commandPublisher.publishUpdateToDevice(
                deviceId,
                {
                  version: release.version,
                  downloadUrl,
                  sha256: release.sha256,
                  signature: release.signature,
                  sizeBytes: release.sizeBytes,
                  expiresAt: expiresAt.toISOString()
                },
                force
              );
            }
          }
        }
      }

      void getAuditService()
        ?.logEvent({
          event: AuditEventType.OTA_PUSH_SENT,
          userId: auth.userId,
          details: { version, target, mode, deviceIds, force }
        })
        .catch(() => undefined);

      res.json({
        success: true,
        version,
        target,
        mode,
        device_ids: deviceIds,
        timestamp: new Date().toISOString()
      });
    } catch (err: unknown) {
      logger.error('[OTA] push failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({
        success: false,
        error: 'Push failed',
        code: 'PUSH_ERROR',
        timestamp: new Date().toISOString()
      });
    }
  });

  return router;
}
