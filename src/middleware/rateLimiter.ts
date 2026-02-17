/**
 * Application-Wide Rate Limiter Middleware
 * 
 * Tiered rate limiting for all HTTP endpoints using Redis counters.
 * 
 * Tiers (applied as separate middleware — multiple can stack):
 * 
 * 1. GLOBAL — Applied to ALL routes (via httpServer.ts setupMiddleware)
 *    - Per-IP: 200 req / 15 min (general API usage)
 *    - Global:  1000 req / 1 min (server-wide cap)
 * 
 * 2. PROVISIONING — Applied to /api/v1/onboarding, /api/v1/sign-csr
 *    - Per-IP: 30 req / 15 min
 *    - Per-device: 15 req / 15 min
 * 
 * 3. CSR (strictest) — Applied only to /api/v1/sign-csr
 *    - Per-device (provisioned):   10 CSRs / 15 min
 *    - Per-device (unprovisioned): 3 CSRs / 15 min
 *    - Per-IP:   5 CSRs / 15 min
 *    - Global CA: 100 CSRs / 1 min
 * 
 * All tiers use Redis for persistence across restarts.
 * All tiers fail-open if Redis is unavailable.
 * Rate limit events are logged to InfluxDB for monitoring dashboards.
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { getRedisService } from '../services/redisService';
import { getInfluxService } from '../services/influxService';

// ─── Redis counter helper ───────────────────────────────────────────────────

async function incrementCounter(key: string, ttlSeconds: number): Promise<{ count: number; ttl: number }> {
  const redis = getRedisService();
  if (!redis) return { count: 0, ttl: ttlSeconds };

  try {
    const client = redis.getClient();
    if (!client) return { count: 0, ttl: ttlSeconds };

    const count = await client.incr(key);
    if (count === 1) {
      await client.expire(key, ttlSeconds);
    }
    const ttl = await client.ttl(key);
    return { count, ttl: ttl > 0 ? ttl : ttlSeconds };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Rate limiter: Redis error, allowing request', { error: msg, key });
    return { count: 0, ttl: ttlSeconds };
  }
}

// ─── 429 response helper ────────────────────────────────────────────────────

function send429(
  res: Response,
  retryAfter: number,
  limit: number,
  remaining: number,
  limitType: string,
  endpoint: string,
  ip: string,
  deviceId?: string
): void {
  const resetTimestamp = Math.floor(Date.now() / 1000) + retryAfter;

  res.set('Retry-After', String(retryAfter));
  res.set('X-RateLimit-Limit', String(limit));
  res.set('X-RateLimit-Remaining', String(Math.max(0, remaining)));
  res.set('X-RateLimit-Reset', String(resetTimestamp));
  res.set('X-RateLimit-Type', limitType);

  // Write rate limit event to InfluxDB (non-blocking)
  try {
    const influx = getInfluxService();
    if (influx) {
      influx.writeRateLimitEvent({
        limitType,
        endpoint,
        ip,
        count: limit - remaining,
        limit,
        deviceId
      }).catch(() => {});
    }
  } catch { /* ignore */ }

  res.status(429).json({
    error: 'RATE_LIMIT_EXCEEDED',
    message: `Too many requests (${limitType}). Please wait ${retryAfter} seconds.`,
    retryAfter,
    limit,
    window: retryAfter >= 60 ? `${Math.floor(retryAfter / 60)}m` : `${retryAfter}s`,
    type: limitType,
    timestamp: new Date().toISOString()
  });
}

// ─── Tier configs from env ──────────────────────────────────────────────────

const WINDOW_SEC = parseInt(process.env.RATE_LIMIT_WINDOW || '900', 10); // 15 min

const GLOBAL_CONFIG = {
  perIp: parseInt(process.env.RATE_LIMIT_GLOBAL_PER_IP || '200', 10),
  globalPerMin: parseInt(process.env.RATE_LIMIT_GLOBAL_PER_MIN || '1000', 10)
};

const PROVISIONING_CONFIG = {
  perIp: parseInt(process.env.RATE_LIMIT_PROV_PER_IP || '30', 10),
  perDevice: parseInt(process.env.RATE_LIMIT_PROV_PER_DEVICE || '15', 10)
};

const CSR_CONFIG = {
  provisionedDevice: parseInt(process.env.CSR_RATE_LIMIT_PROVISIONED || '10', 10),
  unprovisionedDevice: parseInt(process.env.CSR_RATE_LIMIT_UNPROVISIONED || '3', 10),
  perIp: parseInt(process.env.CSR_RATE_LIMIT_PER_IP || '5', 10),
  globalCaPerMin: parseInt(process.env.CSR_RATE_LIMIT_GLOBAL || '100', 10)
};

// ─── TIER 1: Global rate limiter (all routes) ──────────────────────────────

/**
 * Global rate limiter applied to every incoming HTTP request.
 * Protects the server from volumetric attacks and resource exhaustion.
 * 
 * Skips: /health (keep-alive pings must never be rate-limited)
 */
export function globalRateLimiter() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Skip health checks (Render.com, UptimeRobot, etc. ping every 5-10s)
      if (req.path === '/health' || req.path === '/health/') {
        next();
        return;
      }

      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const minuteBucket = Math.floor(Date.now() / 60000);

      // 1. Global server-wide cap (per minute)
      const globalKey = `rl:global:${minuteBucket}`;
      const globalResult = await incrementCounter(globalKey, 60);
      if (globalResult.count > GLOBAL_CONFIG.globalPerMin) {
        logger.warn('Rate limit exceeded: global server cap', {
          count: globalResult.count,
          limit: GLOBAL_CONFIG.globalPerMin,
          ip: clientIp,
          path: req.path
        });
        send429(res, globalResult.ttl, GLOBAL_CONFIG.globalPerMin,
          GLOBAL_CONFIG.globalPerMin - globalResult.count, 'global_server', req.path, clientIp);
        return;
      }

      // 2. Per-IP cap
      const ipKey = `rl:ip:${clientIp}`;
      const ipResult = await incrementCounter(ipKey, WINDOW_SEC);
      if (ipResult.count > GLOBAL_CONFIG.perIp) {
        logger.warn('Rate limit exceeded: global per-IP', {
          count: ipResult.count,
          limit: GLOBAL_CONFIG.perIp,
          ip: clientIp,
          path: req.path
        });
        send429(res, ipResult.ttl, GLOBAL_CONFIG.perIp,
          GLOBAL_CONFIG.perIp - ipResult.count, 'global_ip', req.path, clientIp);
        return;
      }

      // Attach remaining info to response headers for transparency
      res.set('X-RateLimit-Limit', String(GLOBAL_CONFIG.perIp));
      res.set('X-RateLimit-Remaining', String(Math.max(0, GLOBAL_CONFIG.perIp - ipResult.count)));

      next();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Global rate limiter error — allowing request', { error: msg });
      next();
    }
  };
}

// ─── TIER 2: Provisioning rate limiter (/api/v1/*) ─────────────────────────

/**
 * Provisioning rate limiter for onboarding + CSR endpoints.
 * Tighter than global, but looser than CSR-specific.
 */
export function provisioningRateLimiter() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const deviceId = req.body?.device_id;

      // Per-IP for provisioning
      const ipKey = `rl:prov:ip:${clientIp}`;
      const ipResult = await incrementCounter(ipKey, WINDOW_SEC);
      if (ipResult.count > PROVISIONING_CONFIG.perIp) {
        logger.warn('Rate limit exceeded: provisioning per-IP', {
          count: ipResult.count,
          limit: PROVISIONING_CONFIG.perIp,
          ip: clientIp,
          path: req.path
        });
        send429(res, ipResult.ttl, PROVISIONING_CONFIG.perIp,
          PROVISIONING_CONFIG.perIp - ipResult.count, 'provisioning_ip', req.path, clientIp);
        return;
      }

      // Per-device (if device_id provided)
      if (deviceId) {
        const deviceKey = `rl:prov:device:${deviceId}`;
        const deviceResult = await incrementCounter(deviceKey, WINDOW_SEC);
        if (deviceResult.count > PROVISIONING_CONFIG.perDevice) {
          logger.warn('Rate limit exceeded: provisioning per-device', {
            count: deviceResult.count,
            limit: PROVISIONING_CONFIG.perDevice,
            deviceId,
            ip: clientIp
          });
          send429(res, deviceResult.ttl, PROVISIONING_CONFIG.perDevice,
            PROVISIONING_CONFIG.perDevice - deviceResult.count, 'provisioning_device', req.path, clientIp, deviceId);
          return;
        }
      }

      next();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Provisioning rate limiter error — allowing request', { error: msg });
      next();
    }
  };
}

// ─── TIER 3: CSR rate limiter (strictest — /api/v1/sign-csr only) ──────────

/**
 * CSR-specific rate limiter — the strictest tier.
 * Protects the CA from CPU exhaustion (RSA signing is expensive)
 * and brute-force device ID enumeration.
 */
export function csrRateLimiter() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const deviceId = req.body?.device_id;
      const minuteBucket = Math.floor(Date.now() / 60000);

      // 1. Global CA rate limit (per minute — strictest)
      const globalCaKey = `csr:global:${minuteBucket}`;
      const globalResult = await incrementCounter(globalCaKey, 60);
      if (globalResult.count > CSR_CONFIG.globalCaPerMin) {
        logger.warn('CSR rate limit exceeded: global CA', {
          count: globalResult.count,
          limit: CSR_CONFIG.globalCaPerMin,
          ip: clientIp
        });
        send429(res, globalResult.ttl, CSR_CONFIG.globalCaPerMin,
          CSR_CONFIG.globalCaPerMin - globalResult.count, 'csr_global', req.path, clientIp);
        return;
      }

      // 2. Per-IP (CSR-specific, lower than global)
      const csrIpKey = `csr:ip:${clientIp}`;
      const ipResult = await incrementCounter(csrIpKey, WINDOW_SEC);
      if (ipResult.count > CSR_CONFIG.perIp) {
        logger.warn('CSR rate limit exceeded: per-IP', {
          count: ipResult.count,
          limit: CSR_CONFIG.perIp,
          ip: clientIp
        });
        send429(res, ipResult.ttl, CSR_CONFIG.perIp,
          CSR_CONFIG.perIp - ipResult.count, 'csr_ip', req.path, clientIp);
        return;
      }

      // 3. Per-device (provisioned vs unprovisioned)
      if (deviceId) {
        const deviceKey = `csr:provisioned:${deviceId}`;
        const deviceResult = await incrementCounter(deviceKey, WINDOW_SEC);
        if (deviceResult.count > CSR_CONFIG.provisionedDevice) {
          logger.warn('CSR rate limit exceeded: provisioned device', {
            count: deviceResult.count,
            limit: CSR_CONFIG.provisionedDevice,
            deviceId,
            ip: clientIp
          });
          send429(res, deviceResult.ttl, CSR_CONFIG.provisionedDevice,
            CSR_CONFIG.provisionedDevice - deviceResult.count, 'csr_device', req.path, clientIp, deviceId);
          return;
        }
      } else {
        const unProvKey = `csr:unprovisioned:${clientIp}`;
        const unProvResult = await incrementCounter(unProvKey, WINDOW_SEC);
        if (unProvResult.count > CSR_CONFIG.unprovisionedDevice) {
          logger.warn('CSR rate limit exceeded: unprovisioned', {
            count: unProvResult.count,
            limit: CSR_CONFIG.unprovisionedDevice,
            ip: clientIp
          });
          send429(res, unProvResult.ttl, CSR_CONFIG.unprovisionedDevice,
            CSR_CONFIG.unprovisionedDevice - unProvResult.count, 'csr_unprovisioned', req.path, clientIp);
          return;
        }
      }

      next();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('CSR rate limiter error — allowing request', { error: msg });
      next();
    }
  };
}
