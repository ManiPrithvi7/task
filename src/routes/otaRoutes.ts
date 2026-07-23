/**
 * Device OTA routes — download proxy and optional report.
 */

import https from 'https';
import fs from 'fs';
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
import { resolveLocalTestOtaFirmware } from '../utils/localTestOtaFirmware';

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

  const isTestOta = () => process.env.TEST_OTA === 'true';
  const LOCAL_PROOF_OTA_VERSION = 'proof:1.0.1';

  function buildLocalProofDownloadUrl(): string {
    const base = (
      process.env.OTA_PUBLIC_BASE_URL ||
      process.env.PUBLIC_APP_URL ||
      'https://server.withproof.io'
    ).replace(/\/+$/, '');
    return `${base}/api/v1/ota/download/${encodeURIComponent(LOCAL_PROOF_OTA_VERSION)}`;
  }

  // TEST_OTA: firmware resolves proxy download_url via /ota/offer (Railway cannot forward device mTLS).
  function skipMtlsWhenTestOta(req: Request, res: Response, next: (err?: unknown) => void): void {
    if (isTestOta()) {
      next();
      return;
    }
    void requireMtlsDeviceCert({ allowedSlots: ['primary'] })(req, res, next);
  }

  router.get('/ota/offer/:version', skipMtlsWhenTestOta, async (req: Request, res: Response) => {
    try {
      const version = decodeURIComponent(req.params.version);

      if (isTestOta()) {
        const release = await FirmwareRelease.findOne({ status: FirmwareReleaseStatus.STABLE }).sort({
          releasedAt: -1,
          createdAt: -1
        });
        if (!release) {
          res.status(404).json({
            success: false,
            error: 'No OTA offer for this device and version',
            code: 'OTA_OFFER_NOT_FOUND',
            timestamp: new Date().toISOString()
          });
          return;
        }
        const localFw = resolveLocalTestOtaFirmware();
        const sizeBytes = localFw?.sizeBytes ?? release.sizeBytes;
        res.json({
          success: true,
          version: '1.0.1',
          download_url: buildLocalProofDownloadUrl(),
          sha256: release.sha256,
          signature: release.signature,
          size_bytes: sizeBytes,
          expires_at: release.releasedAt?.toISOString?.() ?? new Date().toISOString(),
          timestamp: new Date().toISOString()
        });
        return;
      }

      const deviceId = (req as { deviceId?: string }).deviceId as string;
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
  });

  const DEV_TEST_OTA_VERSION = 'test:1.0.1';
  const DEV_TEST_FIRMWARE_PUBLIC_URL =
    'https://objectstorage.ap-hyderabad-1.oraclecloud.com/n/ax4egmknthnr/b/proof-firmware-dev-download/o/dev%2Fwifi_ap_project.bin';

  function serveLocalProofFirmware(_req: Request, res: Response): void {
    const localFw = resolveLocalTestOtaFirmware();
    if (!localFw) {
      logger.error('[OTA] local firmware file not found in data/');
      res.status(404).json({
        success: false,
        error: 'Local firmware file not found',
        code: 'LOCAL_FIRMWARE_NOT_FOUND',
        timestamp: new Date().toISOString()
      });
      return;
    }
    const { filePath, filename, sizeBytes } = localFw;
    try {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-Firmware-Version', LOCAL_PROOF_OTA_VERSION);
      res.setHeader('Content-Length', String(sizeBytes));
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
  }

  function servePilotFirmware(req: Request, res: Response, version: string): void {
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
  }

  // One download route: local TEST_OTA bin → pilot open proxy → mTLS OCI.
  router.get('/ota/download/:version', async (req: Request, res: Response, next) => {
    const version = decodeURIComponent(req.params.version || '').trim();

    if (version === LOCAL_PROOF_OTA_VERSION) {
      serveLocalProofFirmware(req, res);
      return;
    }

    if (process.env.PILOT_MODE === 'true') {
      servePilotFirmware(req, res, version);
      return;
    }

    void requireMtlsDeviceCert({ allowedSlots: ['primary'] })(req, res, async (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      try {
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
      } catch (downloadErr: unknown) {
        logger.error('[OTA] download proxy failed', {
          error: downloadErr instanceof Error ? downloadErr.message : String(downloadErr)
        });
        if (!res.headersSent) {
          const status = downloadErr instanceof OciStorageError ? downloadErr.httpStatus : 500;
          const code = downloadErr instanceof OciStorageError ? downloadErr.code : 'OTA_DOWNLOAD_ERROR';
          res.status(status).json({
            success: false,
            error: 'Download failed',
            code,
            timestamp: new Date().toISOString()
          });
        }
      }
    });
  });

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
