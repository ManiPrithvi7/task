/**
 * CSR Rate Limiter Middleware
 * 
 * PKI Improvement #6: No Rate Limiting on CSR Submission → Context-Aware Thresholds.
 * 
 * Uses Redis for counter persistence across service restarts.
 * 
 * Rate Limit Tiers:
 * - Per provisioned device: 10 CSRs / 15 min (CERT_RATE_LIMIT_PROVISIONED)
 * - Per unprovisioned: 3 CSRs / 15 min (CERT_RATE_LIMIT_UNPROVISIONED)
 * - Per IP: 5 CSRs / 15 min (CERT_RATE_LIMIT_PER_IP)
 * - Global CA: 100 CSRs / 1 min (CERT_RATE_LIMIT_GLOBAL)
 * 
 * Returns HTTP 429 with standard rate limit headers.
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { getRedisService } from '../services/redisService';

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

/**
 * Increment a Redis counter and return the current count + TTL.
 * If key doesn't exist, creates with TTL.
 */
async function incrementCounter(key: string, ttlSeconds: number): Promise<{ count: number; ttl: number }> {
  const redis = getRedisService();
  if (!redis) {
    // No Redis — skip rate limiting (log warning)
    return { count: 0, ttl: ttlSeconds };
  }

  try {
    const client = redis.getClient();
    if (!client) return { count: 0, ttl: ttlSeconds };

    const count = await client.incr(key);

    // Set TTL only on first increment (count === 1)
    if (count === 1) {
      await client.expire(key, ttlSeconds);
    }

    const ttl = await client.ttl(key);
    return { count, ttl: ttl > 0 ? ttl : ttlSeconds };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('CSR rate limiter: Redis error, allowing request', { error: msg, key });
    return { count: 0, ttl: ttlSeconds };
  }
}

/**
 * Send 429 response with standard rate limit headers.
 */
function sendRateLimitResponse(
  res: Response,
  retryAfter: number,
  limit: number,
  remaining: number,
  limitType: string
): void {
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
      const deviceId = req.body?.device_id;
      const minuteBucket = Math.floor(Date.now() / 60000);

      // 1. Global CA rate limit (per minute)
      const globalKey = `csr:global:${minuteBucket}`;
      const globalResult = await incrementCounter(globalKey, 60);
      if (globalResult.count > cfg.globalLimit) {
        logger.warn('CSR rate limit exceeded: global CA', {
          count: globalResult.count,
          limit: cfg.globalLimit,
          ip: clientIp
        });
        sendRateLimitResponse(res, globalResult.ttl, cfg.globalLimit, cfg.globalLimit - globalResult.count, 'global');
        return;
      }

      // 2. Per-IP rate limit
      const ipKey = `csr:ip:${clientIp}`;
      const ipResult = await incrementCounter(ipKey, cfg.windowSeconds);
      if (ipResult.count > cfg.perIpLimit) {
        logger.warn('CSR rate limit exceeded: per-IP', {
          count: ipResult.count,
          limit: cfg.perIpLimit,
          ip: clientIp
        });
        sendRateLimitResponse(res, ipResult.ttl, cfg.perIpLimit, cfg.perIpLimit - ipResult.count, 'per_ip');
        return;
      }

      // 3. Per-device rate limit (provisioned vs unprovisioned)
      if (deviceId) {
        const deviceKey = `csr:provisioned:${deviceId}`;
        const deviceResult = await incrementCounter(deviceKey, cfg.windowSeconds);
        const limit = cfg.provisionedLimit;
        if (deviceResult.count > limit) {
          logger.warn('CSR rate limit exceeded: per-device (provisioned)', {
            count: deviceResult.count,
            limit,
            deviceId,
            ip: clientIp
          });
          sendRateLimitResponse(res, deviceResult.ttl, limit, limit - deviceResult.count, 'per_device');
          return;
        }
      } else {
        // Unprovisioned: use IP + fingerprint as key
        const unProvKey = `csr:unprovisioned:${clientIp}`;
        const unProvResult = await incrementCounter(unProvKey, cfg.windowSeconds);
        if (unProvResult.count > cfg.unprovisionedLimit) {
          logger.warn('CSR rate limit exceeded: unprovisioned', {
            count: unProvResult.count,
            limit: cfg.unprovisionedLimit,
            ip: clientIp
          });
          sendRateLimitResponse(res, unProvResult.ttl, cfg.unprovisionedLimit, cfg.unprovisionedLimit - unProvResult.count, 'unprovisioned');
          return;
        }
      }

      // All rate checks passed
      next();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('CSR rate limiter error — allowing request through', { error: msg });
      next(); // Fail open
    }
  };
}
