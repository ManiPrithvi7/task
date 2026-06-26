/**
 * Device OTA routes — download proxy and optional report.
 */

import https from 'https';
import { Router, Request, Response } from 'express';
import type { RedisClientType } from 'redis';
import type { OtaConfig } from '../config';
import { requireMtlsDeviceCert } from '../middleware/mtlsAuth';
import { Device } from '../models/Device';
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
    '/ota/offer/:version',
    requireMtlsDeviceCert({ allowedSlots: ['primary'] }),
    async (req: Request, res: Response) => {
      try {
        const deviceId = (req as any).deviceId as string;
        const version = decodeURIComponent(req.params.version);
        const device = await Device.findOne({ clientId: deviceId });
        const currentVersion = device?.firmwareVersion || '0.0.0';

        const offer = await deps.otaService.resolveUpdate({
          deviceId,
          currentVersion
        });

        if (!offer || offer.version !== version) {
          res.status(404).json({
            success: false,
            error: 'No OTA offer for this device and version',
            code: 'OTA_OFFER_NOT_FOUND',
            timestamp: new Date().toISOString()
          });
          return;
        }

        res.json({
          success: true,
          version: offer.version,
          download_url: offer.downloadUrl,
          sha256: offer.sha256,
          signature: offer.signature,
          size_bytes: offer.sizeBytes,
          expires_at: offer.expiresAt,
          timestamp: new Date().toISOString()
        });
      } catch (err: unknown) {
        logger.error('[OTA] offer failed', {
          error: err instanceof Error ? err.message : String(err)
        });
        res.status(500).json({
          success: false,
          error: 'Failed to build OTA offer',
          code: 'OTA_OFFER_ERROR',
          timestamp: new Date().toISOString()
        });
      }
    }
  );

  // ponytail: dev-only open download test — remove after firmware validates HTTP streaming
  const DEV_TEST_OTA_VERSION = 'test:1.1';
  const DEV_TEST_FIRMWARE_PUBLIC_URL =
    'https://objectstorage.ap-hyderabad-1.oraclecloud.com/n/ax4egmknthnr/b/proof-firmware-dev-download/o/dev%2Fwifi_ap_project.bin';

  router.get(/^\/ota\/download\/test:1\.1$/, (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Firmware-Version', DEV_TEST_OTA_VERSION);

    https
      .get(DEV_TEST_FIRMWARE_PUBLIC_URL, (ociRes) => {
        if (!ociRes.statusCode || ociRes.statusCode < 200 || ociRes.statusCode >= 300) {
          res.status(502).json({
            success: false,
            error: 'OCI fetch failed',
            code: 'DEV_OTA_UPSTREAM',
            timestamp: new Date().toISOString()
          });
          return;
        }
        const len = ociRes.headers['content-length'];
        if (len) res.setHeader('Content-Length', len);
        ociRes.pipe(res);
      })
      .on('error', (err) => {
        logger.error('[OTA] dev test download failed', { error: err.message });
        if (!res.headersSent) {
          res.status(502).json({
            success: false,
            error: 'OCI fetch failed',
            code: 'DEV_OTA_UPSTREAM',
            timestamp: new Date().toISOString()
          });
        }
      });
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
