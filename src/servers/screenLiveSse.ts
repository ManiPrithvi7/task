import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { isConnectBurstDevice } from '../config/instagramPollingConfig';
import { getActiveDeviceCache } from '../services/deviceService';
import { getIgDeviceRuntimeCache } from '../services/igDeviceRuntimeCache';
import { getScreenLiveHub, type ScreenLiveClient } from '../services/screenLiveHub';
import type { AuthService } from '../services/authService';
import { isAllowedLoyaltyOrigin } from '../utils/loyaltyOrigin';
import { logger } from '../utils/logger';

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;
const HEARTBEAT_MS = 15_000;

export type ScreenLiveAuth = Pick<AuthService, 'verifyAuthToken'>;

export type ScreenLiveSseDeps = {
  authService?: ScreenLiveAuth;
  isBurstFinished: (deviceId: string) => boolean;
  businessIdForDevice?: (deviceId: string) => Promise<string | undefined>;
  followersForDevice?: (deviceId: string) => number | undefined;
  reviewsForDevice?: (deviceId: string) => number | undefined;
};

export function isScreenLiveRequest(req: { path?: string; originalUrl?: string }): boolean {
  const path = req.path || '';
  const url = req.originalUrl || '';
  return path === '/screen/realtime' || url.startsWith('/screen/realtime');
}

/** Hub JSON line → SSE frame. Event name is the payload's `event` field. */
export function formatScreenLiveSse(payload: string): string {
  let eventName = 'message';
  try {
    const parsed = JSON.parse(payload) as { event?: unknown };
    if (typeof parsed.event === 'string' && parsed.event.trim()) {
      eventName = parsed.event.trim().split(/\r?\n/)[0] || 'message';
    }
  } catch {
    /* still send the raw payload as data */
  }
  const data = payload.split(/\r?\n/).map((line) => `data: ${line}`).join('\n');
  return `event: ${eventName}\n${data}\n\n`;
}

function clientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

async function defaultBusinessIdForDevice(deviceId: string): Promise<string | undefined> {
  const active = await getActiveDeviceCache().getActive(deviceId);
  const fromActive = active?.businessId?.trim();
  if (fromActive) return fromActive;
  return getIgDeviceRuntimeCache().getBusinessId(deviceId)?.trim() || undefined;
}

function originDenyMessage(origin: string | undefined): string | null {
  const env = process.env.NODE_ENV;
  const allowMissingOrigin = env === 'development' || env === 'test';
  if (!origin) {
    return allowMissingOrigin ? null : 'origin required';
  }
  if (!isAllowedLoyaltyOrigin(origin)) return 'origin not allowed';
  return null;
}

function forbid(res: Response, message: string, deviceId: string): void {
  logger.info('[SCREEN_LIVE] stream rejected', { deviceId: deviceId || '(none)', message });
  res.status(403).json({ code: 'FORBIDDEN', message });
}

export function createScreenLiveRoutes(deps: ScreenLiveSseDeps): Router {
  const router = Router();
  const businessIdForDevice = deps.businessIdForDevice ?? defaultBusinessIdForDevice;
  const followersForDevice =
    deps.followersForDevice ?? ((deviceId: string) => getIgDeviceRuntimeCache().getFollowers(deviceId));
  const reviewsForDevice =
    deps.reviewsForDevice ?? ((deviceId: string) => getIgDeviceRuntimeCache().getGmbReviewCount(deviceId));

  const connectLimiter = rateLimit({
    windowMs: RATE_WINDOW_MS,
    max: RATE_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    keyGenerator: (req) => clientIp(req),
    message: { code: 'TOO_MANY_REQUESTS', message: 'too many screen live connections' }
  });

  router.get('/realtime', connectLimiter, (req: Request, res: Response) => {
    void handleScreenLive(req, res, deps, businessIdForDevice, followersForDevice, reviewsForDevice).catch(
      (err: unknown) => {
        logger.error('[SCREEN_LIVE] stream failed', {
          error: err instanceof Error ? err.message : String(err)
        });
        if (res.headersSent) {
          if (!res.writableEnded) res.end();
          return;
        }
        res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
      }
    );
  });

  return router;
}

async function handleScreenLive(
  req: Request,
  res: Response,
  deps: ScreenLiveSseDeps,
  businessIdForDevice: (deviceId: string) => Promise<string | undefined>,
  followersForDevice: (deviceId: string) => number | undefined,
  reviewsForDevice: (deviceId: string) => number | undefined
): Promise<void> {
  const deviceId = (typeof req.query.deviceId === 'string' ? req.query.deviceId : '').trim();
  const originHeader = req.headers.origin;
  const origin = typeof originHeader === 'string' ? originHeader : undefined;
  const originError = originDenyMessage(origin);
  if (originError) {
    forbid(res, originError, deviceId);
    return;
  }

  if (!isConnectBurstDevice(deviceId)) {
    forbid(res, 'device not allowlisted', deviceId);
    return;
  }
  if (deps.isBurstFinished(deviceId)) {
    forbid(res, 'connect burst finished', deviceId);
    return;
  }

  const token = (typeof req.query.token === 'string' ? req.query.token : '').trim();
  let userId: string | undefined;
  if (deps.authService && token) {
    const verified = await deps.authService.verifyAuthToken(token);
    if (verified.valid) userId = verified.userId;
  }

  const businessId = await businessIdForDevice(deviceId);
  if (!userId || !businessId || userId !== businessId) {
    forbid(res, 'business mismatch', deviceId);
    return;
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let stopped = false;
  const client: ScreenLiveClient = {
    send: (data) => {
      if (stopped || res.writableEnded) return;
      res.write(formatScreenLiveSse(data));
    },
    close: () => {
      stop();
    }
  };

  const heartbeat = setInterval(() => {
    if (stopped || res.writableEnded) return;
    try {
      res.write(': ping\n\n');
    } catch {
      stop();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    getScreenLiveHub().detach(deviceId, client);
    if (!res.writableEnded) {
      res.end();
    }
  }

  res.on('close', stop);

  const accepted = getScreenLiveHub().accept(
    {
      deviceId,
      allowlisted: true,
      burstFinished: false,
      userId,
      businessId,
      followers: followersForDevice(deviceId),
      reviews: reviewsForDevice(deviceId)
    },
    client
  );

  if (!accepted) {
    stop();
  }
}
