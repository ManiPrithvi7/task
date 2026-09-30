import type { IncomingMessage, Server } from 'http';
import { WebSocketServer, type WebSocket, type VerifyClientCallbackAsync } from 'ws';
import { isConnectBurstDevice } from '../config/instagramPollingConfig';
import { getActiveDeviceCache } from '../services/deviceService';
import { getIgDeviceRuntimeCache } from '../services/igDeviceRuntimeCache';
import { getScreenLiveHub, type ScreenLiveClient } from '../services/screenLiveHub';
import type { AuthService } from '../services/authService';
import { isAllowedLoyaltyOrigin } from '../utils/loyaltyOrigin';
import { clientIpFromUpgrade } from './loyaltyWs';
import { logger } from '../utils/logger';

const WS_OPEN = 1;
const WS_RATE_WINDOW_MS = 60_000;
const WS_RATE_MAX = 10;
const WS_PING_MS = 30_000;

type RateEntry = { count: number; resetAt: number };

export type ScreenLiveWsDeps = {
  authService?: AuthService;
  isBurstFinished: (deviceId: string) => boolean;
};

export function attachScreenLiveWs(
  server: Server,
  deps: ScreenLiveWsDeps
): { close: () => void } {
  const perIp = new Map<string, RateEntry>();

  const verifyClient: VerifyClientCallbackAsync = (info, done) => {
    const origin = info.origin;
    const env = process.env.NODE_ENV;
    const allowMissingOrigin = env === 'development' || env === 'test';
    if (!origin) {
      if (!allowMissingOrigin) {
        done(false, 403, 'origin required');
        return;
      }
    } else if (!isAllowedLoyaltyOrigin(origin)) {
      done(false, 403, 'origin not allowed');
      return;
    }
    const ip = clientIpFromUpgrade(info.req);
    const now = Date.now();
    const entry = perIp.get(ip);
    if (!entry || entry.resetAt <= now) {
      perIp.set(ip, { count: 1, resetAt: now + WS_RATE_WINDOW_MS });
      done(true);
      return;
    }
    if (entry.count >= WS_RATE_MAX) {
      done(false, 429, 'too many websocket connections');
      return;
    }
    entry.count += 1;
    done(true);
  };

  const wss = new WebSocketServer({
    server,
    path: '/screen/realtime',
    verifyClient
  });

  const pingTimer = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState === WS_OPEN) {
        try {
          client.ping();
        } catch {
          /* ignore */
        }
      }
    }
  }, WS_PING_MS);
  pingTimer.unref?.();

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    void onConnection(socket, req, deps);
  });

  return {
    close: () => {
      clearInterval(pingTimer);
      wss.close();
    }
  };
}

async function businessIdForDevice(deviceId: string): Promise<string | undefined> {
  const active = await getActiveDeviceCache().getActive(deviceId);
  const fromActive = active?.businessId?.trim();
  if (fromActive) return fromActive;
  return getIgDeviceRuntimeCache().getBusinessId(deviceId)?.trim() || undefined;
}

async function onConnection(socket: WebSocket, req: IncomingMessage, deps: ScreenLiveWsDeps): Promise<void> {
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url || '/', `http://${host}`);
  const deviceId = (url.searchParams.get('deviceId') || '').trim();
  const token = (url.searchParams.get('token') || '').trim();

  let userId: string | undefined;
  if (deps.authService && token) {
    const verified = await deps.authService.verifyAuthToken(token);
    if (verified.valid) userId = verified.userId;
  }

  const runtime = getIgDeviceRuntimeCache();
  const businessId = deviceId ? await businessIdForDevice(deviceId) : undefined;
  const client: ScreenLiveClient = {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason)
  };

  const accepted = getScreenLiveHub().accept(
    {
      deviceId,
      allowlisted: Boolean(deviceId) && isConnectBurstDevice(deviceId),
      burstFinished: Boolean(deviceId) && deps.isBurstFinished(deviceId),
      userId,
      businessId,
      followers: deviceId ? runtime.getFollowers(deviceId) : undefined,
      reviews: deviceId ? runtime.getGmbReviewCount(deviceId) : undefined
    },
    client
  );

  if (!accepted) {
    logger.info('[SCREEN_LIVE] socket rejected', { deviceId: deviceId || '(none)' });
    return;
  }

  socket.on('close', () => {
    getScreenLiveHub().detach(deviceId, client);
  });
}
