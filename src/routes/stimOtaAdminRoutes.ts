/**
 * Stim OTA — lab public key + replace-on-upload firmware.
 * TEMP: unauthenticated in non-prod so the upload UI can be tested by anyone.
 */

import cors from 'cors';
import { Router, Request, Response } from 'express';
import type { IFirmwareStorage } from '../services/firmwareStorageService';
import type { RedisService } from '../services/redisService';
import { getRedisService } from '../services/redisService';
import { OciStorageError } from '../services/ociStorageErrors';
import {
  getOrCreateStimLabKeypair,
  loadStimOtaOffer
} from '../services/stimOtaRedis';
import { replaceStimFirmware } from '../services/stimOtaUpload';
import { parseStimFirmwareUpload } from '../utils/stimFirmwareUploadParse';
import { isProductionNodeEnv } from '../utils/stimOtaCrypto';
import { logger } from '../utils/logger';
import { STIM_OTA_ADMIN_HTML } from './stimOtaAdminUi';

export interface StimOtaAdminRoutesDeps {
  storage: IFirmwareStorage;
  redis?: RedisService | null;
}

function forbidProduction(res: Response): boolean {
  if (!isProductionNodeEnv()) return false;
  res.status(403).json({
    success: false,
    error: 'Stim OTA admin is not allowed in production',
    code: 'STIM_OTA_PROD_FORBIDDEN',
    timestamp: new Date().toISOString()
  });
  return true;
}

function collectRawBody(req: Request): Promise<Buffer> {
  if (Buffer.isBuffer((req as { rawBody?: Buffer }).rawBody)) {
    return Promise.resolve((req as { rawBody: Buffer }).rawBody);
  }
  if (Buffer.isBuffer(req.body)) {
    return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createStimOtaAdminRoutes(deps: StimOtaAdminRoutesDeps): Router {
  const router = Router();
  const { storage } = deps;

  const redis = (): RedisService | null => deps.redis ?? getRedisService();

  router.use(cors({ origin: true }));

  router.get('/stim', (_req: Request, res: Response) => {
    if (forbidProduction(res)) return;
    res.type('html').send(STIM_OTA_ADMIN_HTML);
  });

  router.get('/stim/lab-public-key', async (_req: Request, res: Response) => {
    if (forbidProduction(res)) return;
    try {
      const pair = await getOrCreateStimLabKeypair(redis());
      res.type('application/x-pem-file').send(pair.publicPem);
    } catch (err: unknown) {
      logger.warn('[STIM-OTA] lab-public-key failed', {
        error: err instanceof Error ? err.message : String(err)
      });
      res.status(503).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
        code: 'STIM_LAB_KEY_UNAVAILABLE',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.get('/stim/offer', async (_req: Request, res: Response) => {
    if (forbidProduction(res)) return;
    const offer = await loadStimOtaOffer(redis());
    if (!offer) {
      res.status(404).json({
        success: false,
        error: 'No stim OTA offer in Redis',
        code: 'STIM_OFFER_NOT_FOUND',
        timestamp: new Date().toISOString()
      });
      return;
    }
    res.json({
      success: true,
      version: offer.version,
      object_key: offer.objectKey || undefined,
      filename: offer.filename,
      updated_at: offer.updatedAt,
      timestamp: new Date().toISOString()
    });
  });

  router.post('/stim/firmware', async (req: Request, res: Response) => {
    if (forbidProduction(res)) return;
    try {
      const raw = await collectRawBody(req);
      const parsed = parseStimFirmwareUpload(req, raw);
      const offer = await replaceStimFirmware({
        redis: redis(),
        storage,
        version: parsed.version,
        bytes: parsed.bytes,
        filename: parsed.filename
      });
      res.json({
        success: true,
        version: offer.version,
        filename: offer.filename,
        object_key: offer.objectKey,
        timestamp: new Date().toISOString()
      });
    } catch (err: unknown) {
      if (err instanceof OciStorageError) {
        res.status(err.httpStatus).json({
          success: false,
          error: err.message,
          code: err.code,
          timestamp: new Date().toISOString()
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const status = /required|empty|exceeds|boundary|multipart/i.test(message) ? 400 : 500;
      logger.warn('[STIM-OTA] firmware upload failed', { error: message });
      res.status(status).json({
        success: false,
        error: message,
        code: 'STIM_FIRMWARE_UPLOAD_FAILED',
        timestamp: new Date().toISOString()
      });
    }
  });

  return router;
}
