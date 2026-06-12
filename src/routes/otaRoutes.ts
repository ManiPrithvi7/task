/**
 * Device OTA routes — check, download proxy, optional report.
 */

import { Router, Request, Response } from 'express';
import type { RedisClientType } from 'redis';
import type { OtaConfig } from '../config';
import { requireMtlsDeviceCert } from '../middleware/mtlsAuth';
import { FirmwareRelease, FirmwareReleaseStatus } from '../models/FirmwareRelease';
import type { FirmwareStorageService } from '../services/firmwareStorageService';
import { checkOtaRateLimit } from '../services/otaRateLimiter';
import type { OtaEventHandler } from '../services/otaEventHandler';
import type { OtaService } from '../services/otaService';
import { AuditEventType, getAuditService } from '../services/auditService';
import { logger } from '../utils/logger';

export interface OtaRoutesDeps {
  otaConfig: OtaConfig;
  otaService: OtaService;
  storage: FirmwareStorageService;
  eventHandler: OtaEventHandler;
  getRedisClient: () => RedisClientType | null;
  redisKeyPrefix: string;
}

export function createOtaRoutes(deps: OtaRoutesDeps): Router {
  const router = Router();
  const { otaConfig, otaService, storage, eventHandler, getRedisClient, redisKeyPrefix } = deps;

  router.get('/ota/check', requireMtlsDeviceCert({ allowedSlots: ['primary'] }), async (req: Request, res: Response) => {
    try {
      const deviceId = (req as any).deviceId as string;
      const currentVersion = String(req.query.current_version || '').trim();

      if (!currentVersion) {
        res.status(400).json({
          success: false,
          error: 'current_version query parameter is required',
          code: 'MISSING_CURRENT_VERSION',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const allowed = await checkOtaRateLimit(
        getRedisClient(),
        redisKeyPrefix,
        deviceId,
        otaConfig.checkRateLimitSec
      );
      if (!allowed) {
        res.status(429).json({
          success: false,
          error: 'OTA check rate limited',
          code: 'OTA_RATE_LIMITED',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const hardwareRev = req.query.hardware_rev ? String(req.query.hardware_rev) : undefined;
      const platform = req.query.platform ? String(req.query.platform) : undefined;

      const offer = await otaService.resolveUpdate({
        deviceId,
        currentVersion,
        hardwareRev,
        platform
      });

      if (!offer) {
        void getAuditService()
          ?.logEvent({
            event: AuditEventType.OTA_CHECK_NO_UPDATE,
            deviceId,
            details: { currentVersion }
          })
          .catch(() => undefined);

        res.json({
          update_available: false,
          server_time: new Date().toISOString()
        });
        return;
      }

      void getAuditService()
        ?.logEvent({
          event: AuditEventType.OTA_CHECK_OFFERED,
          deviceId,
          details: { currentVersion, offeredVersion: offer.version }
        })
        .catch(() => undefined);

      res.json({
        update_available: true,
        version: offer.version,
        download_url: offer.downloadUrl,
        sha256: offer.sha256,
        signature: offer.signature,
        size_bytes: offer.sizeBytes,
        expires_at: offer.expiresAt
      });
    } catch (err: unknown) {
      logger.error('[OTA] check failed', {
        error: err instanceof Error ? err.message : String(err)
      });
      res.status(500).json({
        success: false,
        error: 'OTA check failed',
        code: 'OTA_CHECK_ERROR',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.get(
    '/ota/download/:version',
    requireMtlsDeviceCert({ allowedSlots: ['primary'] }),
    async (req: Request, res: Response) => {
      try {
        const version = decodeURIComponent(req.params.version);
        const release = await FirmwareRelease.findOne({
          version,
          status: FirmwareReleaseStatus.STABLE
        });

        if (!release) {
          res.status(404).json({
            success: false,
            error: 'Firmware release not found',
            code: 'RELEASE_NOT_FOUND',
            timestamp: new Date().toISOString()
          });
          return;
        }

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('X-Firmware-Version', release.version);
        res.setHeader('Content-Length', String(release.sizeBytes));

        const stream = await storage.getObjectStream(release.s3Key);
        stream.pipe(res);
      } catch (err: unknown) {
        logger.error('[OTA] download proxy failed', {
          error: err instanceof Error ? err.message : String(err)
        });
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            error: 'Download failed',
            code: 'OTA_DOWNLOAD_ERROR',
            timestamp: new Date().toISOString()
          });
        }
      }
    }
  );

  router.post('/ota/report', requireMtlsDeviceCert({ allowedSlots: ['primary'] }), async (req: Request, res: Response) => {
    try {
      const deviceId = (req as any).deviceId as string;

      const allowed = await checkOtaRateLimit(
        getRedisClient(),
        redisKeyPrefix,
        deviceId,
        otaConfig.checkRateLimitSec
      );
      if (!allowed) {
        res.status(429).json({
          success: false,
          error: 'OTA report rate limited',
          code: 'OTA_RATE_LIMITED',
          timestamp: new Date().toISOString()
        });
        return;
      }

      await eventHandler.handle(deviceId, req.body || {});
      res.json({ success: true, timestamp: new Date().toISOString() });
    } catch (err: unknown) {
      logger.error('[OTA] report failed', {
        error: err instanceof Error ? err.message : String(err)
      });
      res.status(500).json({
        success: false,
        error: 'OTA report failed',
        code: 'OTA_REPORT_ERROR',
        timestamp: new Date().toISOString()
      });
    }
  });

  return router;
}
