import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import { LoyaltyService, validateLoyaltyResult } from '../services/loyaltyService';
import type { LoyaltyConfig } from '../config/loyaltyConfig';
import { loyaltySecretRequired } from '../config/loyaltyConfig';
import { LoyaltyHttpError } from '../utils/loyaltyErrors';
import { isAllowedLoyaltyOrigin } from '../utils/loyaltyOrigin';
import { safeEqualString } from '../utils/safeEqual';
import { logger } from '../utils/logger';

export type LoyaltyRoutesDeps = {
  service?: LoyaltyService;
  getService?: () => LoyaltyService | Promise<LoyaltyService>;
  tryService?: () => LoyaltyService | undefined;
  loyalty: LoyaltyConfig;
  env: string;
};

function demandService(deps: LoyaltyRoutesDeps): Promise<LoyaltyService> | LoyaltyService {
  return deps.service ?? deps.getService!();
}

function sendLoyaltyError(res: Response, err: unknown): void {
  if (err instanceof LoyaltyHttpError) {
    res.status(err.status).json({ code: err.code, message: err.message });
    return;
  }
  logger.error('loyalty unhandled error', { error: err instanceof Error ? err.message : String(err) });
  res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
}

export function requireLoyaltySpinKey(loyalty: LoyaltyConfig, env: string) {
  return (req: Request, res: Response, next: () => void): void => {
    const required = loyaltySecretRequired(env) || Boolean(loyalty.spinSecret);
    if (!required) {
      next();
      return;
    }
    if (!loyalty.spinSecret) {
      res.status(503).json({ code: 'LOYALTY_MISCONFIGURED', message: 'Loyalty spin secret is not configured' });
      return;
    }
    const provided = req.headers['x-loyalty-key'];
    const key = typeof provided === 'string' ? provided : '';
    if (!key || !safeEqualString(key, loyalty.spinSecret)) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid or missing X-Loyalty-Key' });
      return;
    }
    next();
  };
}

export function createLoyaltyRoutes(deps: LoyaltyRoutesDeps): Router {
  const router = Router();
  const { loyalty, env } = deps;

  router.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) {
          cb(null, true);
          return;
        }
        cb(null, isAllowedLoyaltyOrigin(origin));
      },
      credentials: false,
      methods: ['GET', 'POST', 'OPTIONS']
    })
  );

  const joinLimiter = rateLimit({
    windowMs: 60_000,
    max: parseInt(process.env.LOYALTY_JOIN_RATE_MAX || '60', 10),
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    keyGenerator: (req) => {
      const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId.trim() : '';
      return `join:${deviceId || 'missing'}`;
    },
    message: { code: 'RATE_LIMITED', message: 'Too many join attempts' }
  });

  const spinLimiter = rateLimit({
    windowMs: 60_000,
    max: parseInt(process.env.LOYALTY_SPIN_RATE_MAX || '30', 10),
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    keyGenerator: (req) => {
      const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
      return `spin:${sessionId || 'missing'}`;
    },
    message: { code: 'RATE_LIMITED', message: 'Too many spin attempts' }
  });

  /**
   * @swagger
   * /loyalty/join:
   *   post:
   *     tags: [Loyalty]
   *     summary: Create a loyalty spin session for a device
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [deviceId]
   *             properties:
   *               deviceId:
   *                 type: string
   *     responses:
   *       201:
   *         description: Session created
   *       409:
   *         description: Active session exists
   *       503:
   *         description: Device offline
   */
  router.post('/join', joinLimiter, async (req: Request, res: Response) => {
    try {
      const body = await (await demandService(deps)).join(req.body?.deviceId);
      res.status(201).json(body);
    } catch (err: unknown) {
      sendLoyaltyError(res, err);
    }
  });

  /**
   * @swagger
   * /loyalty/spin:
   *   post:
   *     tags: [Loyalty]
   *     summary: Publish a statsnapp-provided spin result to the device (server-to-server)
   *     security:
   *       - LoyaltyKey: []
   */
  router.post(
    '/spin',
    requireLoyaltySpinKey(loyalty, env),
    spinLimiter,
    async (req: Request, res: Response) => {
      try {
        validateLoyaltyResult(req.body?.result);
        const body = await (await demandService(deps)).spin({
          sessionId: req.body?.sessionId,
          idempotencyKey: req.body?.idempotencyKey,
          spinId: req.body?.spinId,
          result: req.body.result
        });
        res.status(200).json(body);
      } catch (err: unknown) {
        sendLoyaltyError(res, err);
      }
    }
  );

  /**
   * @swagger
   * /loyalty/spin/{spinId}:
   *   get:
   *     tags: [Loyalty]
   *     summary: Fetch spin status; result included only after device ack
   */
  router.get('/spin/:spinId', async (req: Request, res: Response) => {
    try {
      const svc = deps.service ?? deps.tryService?.();
      if (!svc) {
        res.status(404).json({ code: 'SPIN_NOT_FOUND', message: 'Unknown spinId' });
        return;
      }
      const body = await svc.getSpin(req.params.spinId);
      res.status(200).json(body);
    } catch (err: unknown) {
      sendLoyaltyError(res, err);
    }
  });

  return router;
}
