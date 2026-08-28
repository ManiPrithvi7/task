import type { IncomingMessage, Server } from 'http';
import { WebSocketServer, type WebSocket, type VerifyClientCallbackAsync } from 'ws';
import { LoyaltyService } from '../services/loyaltyService';
import { LoyaltyHttpError } from '../utils/loyaltyErrors';
import { isAllowedLoyaltyOrigin } from '../utils/loyaltyOrigin';
import { logger } from '../utils/logger';

const WS_OPEN = 1;
const WS_RATE_WINDOW_MS = 60_000;
const WS_RATE_MAX = 10;
const WS_PING_MS = 30_000;

type RateEntry = { count: number; resetAt: number };

export function clientIpFromUpgrade(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

export function attachLoyaltyWs(
  server: Server,
  service: LoyaltyService
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
    path: '/loyalty/realtime',
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
    void onConnection(socket, req, service);
  });

  return {
    close: () => {
      clearInterval(pingTimer);
      wss.close();
    }
  };
}

async function onConnection(socket: WebSocket, req: IncomingMessage, service: LoyaltyService): Promise<void> {
  let sessionId = '';
  try {
    const host = req.headers.host || 'localhost';
    const url = new URL(req.url || '/', `http://${host}`);
    sessionId = url.searchParams.get('sessionId') || '';
    if (!sessionId) {
      socket.send(JSON.stringify({ event: 'loyalty.session.error', code: 'SESSION_INVALID', message: 'sessionId required' }));
      socket.close(4401, 'sessionId required');
      return;
    }

    const ready = await service.attachWs(sessionId, {
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
      get readyState() {
        return socket.readyState === WS_OPEN ? 1 : socket.readyState;
      }
    });

    socket.send(
      JSON.stringify({
        event: 'loyalty.session.ready',
        sessionId: ready.sessionId,
        deviceId: ready.deviceId
      })
    );

    socket.on('close', () => {
      service.detachWs(ready.deviceId, ready.sessionId);
    });
  } catch (err: unknown) {
    const code = err instanceof LoyaltyHttpError ? err.code : 'SESSION_INVALID';
    const message = err instanceof Error ? err.message : 'Invalid session';
    try {
      socket.send(JSON.stringify({ event: 'loyalty.session.error', code, message }));
    } catch {
      /* ignore */
    }
    socket.close(4401, code);
    logger.info('loyalty WS rejected', { sessionId, code, message });
  }
}
