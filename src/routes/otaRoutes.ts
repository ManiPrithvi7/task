/**
 * Device OTA routes — download proxy and optional report.
 */

import { Router, Request, Response } from 'express';
import type { RedisClientType } from 'redis';
import type { OtaConfig } from '../config';
import { requireMtlsDeviceCert } from '../middleware/mtlsAuth';
import { FirmwareRelease, FirmwareReleaseStatus } from '../models/FirmwareRelease';
import type { IFirmwareStorage } from '../services/firmwareStorageService';
import { OciStorageError } from '../services/ociStorageErrors';
import { getReleaseObjectKey } from '../utils/firmwareReleaseKey';
import { checkOtaRateLimit } from '../services/otaService';
import type { OtaEventHandler } from '../services/otaService';
import type { OtaService } from '../services/otaService';
import { logger } from '../utils/logger';

export interface OtaRoutesDeps {
  otaConfig: OtaConfig;
  otaService: OtaService;
  storage: IFirmwareStorage;
  eventHandler: OtaEventHandler;
  getRedisClient: () => RedisClientType | null;
  redisKeyPrefix: string;
}

export function createOtaRoutes(deps: OtaRoutesDeps): Router {
  const router = Router();
  const { otaConfig, storage, eventHandler, getRedisClient, redisKeyPrefix } = deps;

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

        const stream = await storage.getObjectStream(getReleaseObjectKey(release));
        stream.pipe(res);
      } catch (err: unknown) {
        logger.error('[OTA] download proxy failed', {
          error: err instanceof Error ? err.message : String(err)
        });
        if (!res.headersSent) {
          const status = err instanceof OciStorageError ? err.httpStatus : 500;
          const code = err instanceof OciStorageError ? err.code : 'OTA_DOWNLOAD_ERROR';
          res.status(status).json({
            success: false,
            error: 'Download failed',
            code,
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
