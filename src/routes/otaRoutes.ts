/**
 * Device OTA routes — download proxy and optional report.
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
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
  const pilotDownloadHits = new Map<string, { count: number; resetAt: number }>();

  function isValidPilotVersion(version: string): boolean {
    return /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(version) || /^test:[0-9]+\.[0-9]+$/.test(version);
  }

  function checkPilotRateLimit(req: Request): { allowed: boolean; retryAfter: number } {
    const now = Date.now();
    const windowMs = 60_000;
    const limit = parseInt(process.env.PILOT_OTA_RATE_LIMIT_PER_MIN || '10', 10);
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const current = pilotDownloadHits.get(ip);
    if (!current || current.resetAt <= now) {
      pilotDownloadHits.set(ip, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfter: 60 };
    }
    current.count += 1;
    if (current.count > limit) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
    }
    return { allowed: true, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }

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

  const DEV_TEST_OTA_VERSION = 'test:1.1';
  const DEV_TEST_FIRMWARE_PUBLIC_URL =
    'https://objectstorage.ap-hyderabad-1.oraclecloud.com/n/ax4egmknthnr/b/proof-firmware-dev-download/o/dev%2Fwifi_ap_project.bin';

  router.get('/ota/download/proof:1.0.1', (req: Request, res: Response) => {
    const filePath = path.resolve('data/ESP32s3_OTA_v104.ino.bin');
    try {
      const stat = fs.statSync(filePath);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="ESP32s3_OTA_v104.ino.bin"');
      res.setHeader('X-Firmware-Version', 'proof:1.0.1');
      res.setHeader('Content-Length', String(stat.size));
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
      stream.on('error', (err) => {
        logger.error('[OTA] local file stream error', { error: err.message, filePath });
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            error: 'Local firmware read failed',
            code: 'LOCAL_FIRMWARE_READ_ERROR',
            timestamp: new Date().toISOString()
          });
        }
      });
    } catch (err) {
      logger.error('[OTA] local firmware file not found', { error: (err as Error).message, filePath });
      res.status(404).json({
        success: false,
        error: 'Local firmware file not found',
        code: 'LOCAL_FIRMWARE_NOT_FOUND',
        timestamp: new Date().toISOString()
      });
    }
  });

  // PILOT v1 ONLY — remove or protect before GA.
  router.get('/ota/download/:version', (req: Request, res: Response, next) => {
    if (process.env.PILOT_MODE !== 'true') {
      next();
      return;
    }

    const version = decodeURIComponent(req.params.version || '').trim();
    if (!isValidPilotVersion(version)) {
      res.status(400).json({
        success: false,
        error: 'Invalid firmware version',
        code: 'INVALID_VERSION',
        timestamp: new Date().toISOString()
      });
      return;
    }

    const rate = checkPilotRateLimit(req);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfter));
      res.status(429).json({
        success: false,
        error: 'OTA download rate limited',
        code: 'PILOT_OTA_RATE_LIMITED',
        timestamp: new Date().toISOString()
      });
      return;
    }

    const baseUrl = process.env.PILOT_OTA_DOWNLOAD_BASE_URL?.replace(/\/+$/, '');
    const firmwareUrl =
      version === DEV_TEST_OTA_VERSION
        ? DEV_TEST_FIRMWARE_PUBLIC_URL
        : baseUrl
          ? `${baseUrl}/${encodeURIComponent(version)}.bin`
          : '';

    logger.warn('[OTA] PILOT open firmware download accessed', {
      version,
      ip: req.ip || req.socket.remoteAddress || 'unknown',
      hasPilotBaseUrl: Boolean(baseUrl)
    });

    if (!firmwareUrl) {
      res.status(404).json({
        success: false,
        error: 'Pilot firmware URL not configured for this version',
        code: 'PILOT_OTA_NOT_CONFIGURED',
        timestamp: new Date().toISOString()
      });
      return;
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Firmware-Version', version);

    https
      .get(firmwareUrl, (ociRes) => {
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
        logger.error('[OTA] pilot download failed', { error: err.message, version });
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
