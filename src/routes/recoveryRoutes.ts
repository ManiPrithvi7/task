import { Router, Request, Response } from 'express';
import { Device } from '../models/Device';
import { RecoverySessionService } from '../services/recoverySessionService';
import { AuthService } from '../services/authService';
import { logger } from '../utils/logger';

export interface RecoveryRoutesDeps {
  recoverySessionService: RecoverySessionService;
  authService: AuthService;
}

function bearerToken(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h || typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() || null;
}

export function createRecoveryRoutes(deps: RecoveryRoutesDeps): Router {
  const router = Router();
  const { recoverySessionService, authService } = deps;

  /**
   * @swagger
   * /api/v1/recovery/generate-session:
   *   post:
   *     tags: [Recovery]
   *     summary: Register recovery session
   *     description: |
   *       Also available at POST /api/recovery/generate-session (legacy alias).
   *       Requires user JWT and device recovery token from dashboard.
   *     security:
   *       - BearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/RecoveryGenerateSessionRequest'
   *     responses:
   *       200:
   *         description: Recovery session registered
   *       401:
   *         $ref: '#/components/responses/Unauthorized'
   *       403:
   *         $ref: '#/components/responses/Forbidden'
   *       404:
   *         $ref: '#/components/responses/NotFound'
   *       429:
   *         $ref: '#/components/responses/TooManyRequests'
   *       503:
   *         $ref: '#/components/responses/ServiceUnavailable'
   * /api/recovery/generate-session:
   *   post:
   *     tags: [Recovery]
   *     summary: Register recovery session (legacy alias)
   *     security:
   *       - BearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/RecoveryGenerateSessionRequest'
   *     responses:
   *       200:
   *         description: Recovery session registered
   *       401:
   *         $ref: '#/components/responses/Unauthorized'
   */
  router.post('/recovery/generate-session', async (req: Request, res: Response) => {
    try {
      res.type('application/json');

      if (!recoverySessionService.isAvailable()) {
        res.status(503).json({
          success: false,
          error: 'Recovery storage unavailable',
          code: 'REDIS_UNAVAILABLE',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const userBearer = bearerToken(req);
      if (!userBearer) {
        res.status(401).json({
          success: false,
          error: 'Authorization Bearer token required',
          code: 'UNAUTHORIZED',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const userAuth = await authService.verifyAuthToken(userBearer);
      if (!userAuth.valid || !userAuth.userId) {
        res.status(401).json({
          success: false,
          error: userAuth.error || 'Invalid authorization',
          code: 'UNAUTHORIZED',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const body = req.body as {
        device_id?: string;
        token?: string;
        force_reissue?: boolean;
      };
      const raw = body?.device_id;
      const rawToken = body?.token;
      const forceReissue = body?.force_reissue === true;
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        res.status(400).json({
          success: false,
          error: 'device_id is required',
          code: 'DEVICE_ID_REQUIRED',
          timestamp: new Date().toISOString()
        });
        return;
      }
      if (typeof rawToken !== 'string' || rawToken.trim().length === 0) {
        res.status(400).json({
          success: false,
          error: 'token is required',
          code: 'TOKEN_REQUIRED',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const requestedDeviceId = raw.trim();
      logger.info('recovery generate-session request received', { requestedDeviceId, forceReissue });

      const device = await Device.findOne({ clientId: requestedDeviceId });
      if (!device) {
        res.status(404).json({
          success: false,
          error: 'Device not found',
          code: 'DEVICE_NOT_FOUND',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const deviceId = device.clientId;
      if (device.businessId && String(device.businessId) !== userAuth.userId) {
        res.status(403).json({
          success: false,
          error: 'Device does not belong to authenticated user',
          code: 'FORBIDDEN',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const result = await recoverySessionService.registerSession(
        deviceId,
        rawToken.trim(),
        userAuth.userId,
        { forceReissue }
      );

      if ('error' in result) {
        if (result.error === 'GENERATE_RATE_LIMITED') {
          const active = await recoverySessionService.getActiveSessionTtl(deviceId);
          res.status(429).json({
            success: false,
            error: 'Recovery session already issued for this device. Please wait until it expires.',
            code: 'GENERATE_RATE_LIMITED',
            expires_in: 'exists' in active && active.exists ? active.ttlSec : undefined,
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
        const clientErrors = new Set([
          'TOKEN_INVALID',
          'TOKEN_CLAIM_MISMATCH',
          'SESSION_EXPIRED'
        ]);
        res.status(clientErrors.has(result.error) ? 400 : 503).json({
          success: false,
          error: 'Failed to register recovery session',
          code: result.error,
          timestamp: new Date().toISOString()
        });
        return;
      }

      logger.info('recovery session registered', {
        deviceId,
        jtiPrefix: result.jti.slice(0, 8)
      });

      res.status(200).json({
        success: true,
        expires_in: result.expiresIn,
        device_id: deviceId,
        timestamp: new Date().toISOString()
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('recovery generate-session failed', { error: msg });
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
