import { Router, Request, Response } from 'express';
import { Device } from '../models/Device';
import { RecoveryCodeService } from '../services/recoveryCodeService';
import { logger } from '../utils/logger';

export interface RecoveryRoutesDeps {
  recoveryCodeService: RecoveryCodeService;
}

/**
 * POST /api/v1/recovery/generate-code
 * Body: { device_id: string }
 */
export function createRecoveryRoutes(deps: RecoveryRoutesDeps): Router {
  const router = Router();
  const { recoveryCodeService } = deps;

  router.post('/recovery/generate-code', async (req: Request, res: Response) => {
    try {
      if (!recoveryCodeService.isAvailable()) {
        res.status(503).json({
          success: false,
          error: 'Recovery storage unavailable',
          code: 'REDIS_UNAVAILABLE',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const raw = (req.body as any)?.device_id;
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        res.status(400).json({
          success: false,
          error: 'device_id is required',
          code: 'DEVICE_ID_REQUIRED',
          timestamp: new Date().toISOString()
        });
        return;
      }
console.log({raw})
      const deviceId = raw.trim();
      logger.info('recovery generate-code request received', { requestedDeviceId: raw, deviceId });

      const device = await Device.findOne({ clientId: deviceId });
      if (!device) {
        res.status(404).json({
          success: false,
          error: 'Device not found',
          code: 'DEVICE_NOT_FOUND',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const active = await recoveryCodeService.getActiveCodeTtl(deviceId);
      if ('error' in active) {
        res.status(503).json({
          success: false,
          error: 'Recovery storage unavailable',
          code: 'REDIS_UNAVAILABLE',
          timestamp: new Date().toISOString()
        });
        return;
      }
      if (active.exists) {
        res.status(429).json({
          success: false,
          error: 'Recovery code already issued for this device. Please wait until it expires.',
          code: 'GENERATE_RATE_LIMITED',
          expires_in: active.ttlSec,
          timestamp: new Date().toISOString()
        });
        return;
      }

      const result = await recoveryCodeService.generateCode(deviceId);
      if ('error' in result) {
        if (result.error === 'GENERATE_RATE_LIMITED') {
          res.status(429).json({
            success: false,
            error: 'Recovery code already issued for this device. Please wait until it expires.',
            code: 'GENERATE_RATE_LIMITED',
            timestamp: new Date().toISOString()
          });
          return;
        }
        if (result.error === 'REDIS_UNAVAILABLE') {
          res.status(503).json({
            success: false,
            error: 'Recovery storage unavailable',
            code: 'REDIS_UNAVAILABLE',
            timestamp: new Date().toISOString()
          });
          return;
        }
        res.status(503).json({
          success: false,
          error: 'Failed to generate recovery code',
          code: result.error,
          timestamp: new Date().toISOString()
        });
        return;
      }

      logger.info('recovery code generated', { deviceId });

      res.status(200).json({
        success: true,
        code: result.code,
        expires_in: result.expiresIn,
        // Echo the exact keying device_id so the caller can reuse it for /certificates/reissue.
        device_id: deviceId,
        timestamp: new Date().toISOString()
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('recovery generate-code failed', { error: msg });
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        code: 'GENERATE_FAILED',
        timestamp: new Date().toISOString()
      });
    }
  });

  return router;
}
