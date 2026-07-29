/**
 * CSR Rate Limiter Middleware
 *
 * PKI Improvement #6: No Rate Limiting on CSR Submission → Context-Aware Thresholds.
 *
 * When Redis is connected: one short-circuit Lua EVALSHA per request (global → IP → device).
 * When Redis is absent: per-process in-memory Map (not shared across instances).
 * When Redis is connected but Lua fails (timeout/NOSCRIPT after reload): fail open — never
 * re-INCR on Redis (avoids double-count if the script already applied).
 *
 * Rate Limit Tiers:
 * - Per provisioned device: 10 CSRs / 15 min (CSR_RATE_LIMIT_PROVISIONED)
 * - Per unprovisioned: 3 CSRs / 15 min (CSR_RATE_LIMIT_UNPROVISIONED)
 * - Per IP: 5 CSRs / 15 min (CSR_RATE_LIMIT_PER_IP)
 * - Global CA: 100 CSRs / 1 min (CSR_RATE_LIMIT_GLOBAL)
 *
 * Returns HTTP 429 with standard rate limit headers.
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { getRedisService } from '../services/redisService';
import { evalCsrRateLimitSha } from './csrRateLimitLua';

export interface RateLimitConfig {
  /** Max CSRs per provisioned device in window */
  provisionedLimit: number;
  /** Max CSRs per unprovisioned request in window */
  unprovisionedLimit: number;
  /** Max CSRs per IP in window */
  perIpLimit: number;
  /** Global CA rate limit per minute */
  globalLimit: number;
  /** Window in seconds (default 900 = 15 min) */
  windowSeconds: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  provisionedLimit: parseInt(process.env.CSR_RATE_LIMIT_PROVISIONED || '10', 10),
  unprovisionedLimit: parseInt(process.env.CSR_RATE_LIMIT_UNPROVISIONED || '3', 10),
  perIpLimit: parseInt(process.env.CSR_RATE_LIMIT_PER_IP || '5', 10),
  globalLimit: parseInt(process.env.CSR_RATE_LIMIT_GLOBAL || '100', 10),
  windowSeconds: parseInt(process.env.CSR_RATE_LIMIT_WINDOW || '900', 10)
};

const localCounters = new Map<string, { count: number; expiresAt: number }>();

/** Test helper: clear in-memory counters. */
export function resetCsrLocalCounters(): void {
  localCounters.clear();
}

function incrementLocalCounter(key: string, ttlSeconds: number): { count: number; ttl: number } {
  const now = Date.now();
  const existing = localCounters.get(key);
  if (!existing || existing.expiresAt <= now) {
    localCounters.set(key, { count: 1, expiresAt: now + ttlSeconds * 1000 });
    return { count: 1, ttl: ttlSeconds };
  }
  existing.count += 1;
  return {
    count: existing.count,
    ttl: Math.max(1, Math.ceil((existing.expiresAt - now) / 1000))
  };
}

/**
 * Local-only short-circuit rate check (Redis absent).
 * Mirrors Lua: global → IP → device/unprovisioned; stop on first exceed.
 */
function checkLocalShortCircuit(
  cfg: RateLimitConfig,
  clientIp: string,
  deviceId: string | undefined,
  minuteBucket: number
):
  | { allowed: true }
  | {
      allowed: false;
      retryAfter: number;
      limit: number;
      count: number;
      limitType: string;
    } {
  const globalKey = `csr:global:${minuteBucket}`;
  const globalResult = incrementLocalCounter(globalKey, 60);
  if (globalResult.count > cfg.globalLimit) {
    return {
      allowed: false,
      retryAfter: globalResult.ttl,
      limit: cfg.globalLimit,
      count: globalResult.count,
      limitType: 'global'
    };
  }

  const ipKey = `csr:ip:${clientIp}`;
  const ipResult = incrementLocalCounter(ipKey, cfg.windowSeconds);
  if (ipResult.count > cfg.perIpLimit) {
    return {
      allowed: false,
      retryAfter: ipResult.ttl,
      limit: cfg.perIpLimit,
      count: ipResult.count,
      limitType: 'per_ip'
    };
  }

  if (deviceId) {
    const deviceKey = `csr:provisioned:${deviceId}`;
    const deviceResult = incrementLocalCounter(deviceKey, cfg.windowSeconds);
    if (deviceResult.count > cfg.provisionedLimit) {
      return {
        allowed: false,
        retryAfter: deviceResult.ttl,
        limit: cfg.provisionedLimit,
        count: deviceResult.count,
        limitType: 'per_device'
      };
    }
  } else {
    const unProvKey = `csr:unprovisioned:${clientIp}`;
    const unProvResult = incrementLocalCounter(unProvKey, cfg.windowSeconds);
    if (unProvResult.count > cfg.unprovisionedLimit) {
      return {
        allowed: false,
        retryAfter: unProvResult.ttl,
        limit: cfg.unprovisionedLimit,
        count: unProvResult.count,
        limitType: 'unprovisioned'
      };
    }
  }

  return { allowed: true };
}

/**
 * Send 429 response with standard rate limit headers and audit event.
 */
async function rejectRateLimited(
  req: Request,
  res: Response,
  retryAfter: number,
  limit: number,
  remaining: number,
  limitType: string,
  deviceId?: string
): Promise<void> {
  try {
    const { getAuditService, AuditEventType } = await import('../services/auditService');
    const auditSvc = getAuditService();
    if (auditSvc) {
      await auditSvc.logEvent({
        event: AuditEventType.CSR_RATE_LIMITED,
        deviceId: typeof deviceId === 'string' ? deviceId : undefined,
        details: {
          limitType,
          limit,
          retryAfter,
          ip: req.ip || req.socket.remoteAddress || 'unknown'
        }
      });
    }
  } catch {
    /* audit optional */
  }

  const resetTimestamp = Math.floor(Date.now() / 1000) + retryAfter;

  res.set('Retry-After', String(retryAfter));
  res.set('X-RateLimit-Limit', String(limit));
  res.set('X-RateLimit-Remaining', String(Math.max(0, remaining)));
  res.set('X-RateLimit-Reset', String(resetTimestamp));
  res.set('X-RateLimit-Type', limitType);

  res.status(429).json({
    error: 'RATE_LIMIT_EXCEEDED',
    message: `Too many CSR requests (${limitType}). Please wait ${retryAfter} seconds.`,
    retryAfter,
    limit,
    window: `${Math.floor(retryAfter / 60)}m`,
    type: limitType,
    timestamp: new Date().toISOString()
  });
}

/**
 * Express middleware for CSR rate limiting.
 * Apply to the /sign-csr route.
 */
export function csrRateLimiter(config?: Partial<RateLimitConfig>) {
  const cfg: RateLimitConfig = { ...DEFAULT_CONFIG, ...config };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const deviceId =
        typeof req.body?.device_id === 'string' ? req.body.device_id : undefined;
      const minuteBucket = Math.floor(Date.now() / 60000);

      const redis = getRedisService();
      const redisConnected = Boolean(redis?.isRedisConnected());

      if (!redisConnected) {
        logger.warn('CSR rate limiter: Redis unavailable, using local in-memory fallback');
        const local = checkLocalShortCircuit(cfg, clientIp, deviceId, minuteBucket);
        if (!local.allowed) {
          logger.warn(`CSR rate limit exceeded: ${local.limitType}`, {
            count: local.count,
            limit: local.limit,
            ip: clientIp,
            deviceId
          });
          await rejectRateLimited(
            req,
            res,
            local.retryAfter,
            local.limit,
            local.limit - local.count,
            local.limitType,
            deviceId
          );
          return;
        }
        next();
        return;
      }

      const thirdKey = deviceId
        ? `csr:provisioned:${deviceId}`
        : `csr:unprovisioned:${clientIp}`;
      const thirdLimit = deviceId ? cfg.provisionedLimit : cfg.unprovisionedLimit;
      const thirdType = deviceId ? 'per_device' : 'unprovisioned';

      try {
        const client = redis!.getClient();
        const result = await evalCsrRateLimitSha(client, {
          keys: [`csr:global:${minuteBucket}`, `csr:ip:${clientIp}`, thirdKey],
          limits: [cfg.globalLimit, cfg.perIpLimit, thirdLimit],
          windows: [60, cfg.windowSeconds, cfg.windowSeconds]
        });

        if (!result.allowed) {
          const limitType =
            result.limitType === 'device' ? thirdType : result.limitType || 'global';
          logger.warn(`CSR rate limit exceeded: ${limitType}`, {
            count: result.count,
            limit: result.limit,
            ip: clientIp,
            deviceId
          });
          await rejectRateLimited(
            req,
            res,
            result.retryAfter,
            result.limit,
            result.limit - result.count,
            limitType,
            deviceId
          );
          return;
        }

        next();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // Fail open — do NOT sequential Redis INCR (avoids double-count if Lua applied).
        logger.warn('CSR rate limiter: Lua/Redis error — allowing request through', {
          error: msg
        });
        next();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('CSR rate limiter error — allowing request through', { error: msg });
      next(); // Fail open
    }
  };
}
