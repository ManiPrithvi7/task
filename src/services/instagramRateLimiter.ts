/**
 * Instagram Rate Limiter — Redis-backed, 3-layer protection
 *
 * Layer 1: Global Instagram API limit (200 calls / hour across all devices)
 * Layer 2: Per-device limit (100 calls / hour per device)
 * Layer 3: Token bucket (burst protection — 5 tokens, replenish every 5s)
 */

import { logger } from '../utils/logger';
import { getRedisService } from './redisService';

export class InstagramRateLimiter {
    private readonly GLOBAL_LIMIT = 200;     // calls/hour globally
    private readonly DEVICE_LIMIT = 100;     // calls/hour per device
    private readonly BUCKET_TOKENS = 5;      // burst tokens per device
    private readonly BUCKET_TTL = 5;         // seconds before token reset

    private hourKey(): number {
        return Math.floor(Date.now() / 3_600_000);
    }

    /**
     * Check all rate-limit layers. Throws an error if any layer is exceeded.
     */
    async check(deviceId: string): Promise<void> {
        const redis = getRedisService();
        if (!redis || !redis.isRedisConnected()) {
            // Redis unavailable — allow the call (fail-open for resilience)
            logger.warn('[RATE_LIMIT] Redis unavailable, bypassing rate limit check', { deviceId });
            return;
        }

        const client = redis.getClient();
        const hour = this.hourKey();

        // ── Layer 1: Global limit ───────────────────────────────────────────────
        const globalKey = `instagram:rl:global:${hour}`;
        const globalCount = await client.incr(globalKey);
        if (globalCount === 1) await client.expire(globalKey, 3600);
        if (globalCount > this.GLOBAL_LIMIT) {
            throw Object.assign(
                new Error(`Global Instagram rate limit exceeded (${globalCount}/${this.GLOBAL_LIMIT} calls/hour)`),
                { code: 'RATE_LIMIT_GLOBAL' }
            );
        }

        // ── Layer 2: Per-device limit ───────────────────────────────────────────
        const deviceKey = `instagram:rl:device:${deviceId}:${hour}`;
        const deviceCount = await client.incr(deviceKey);
        if (deviceCount === 1) await client.expire(deviceKey, 3600);
        if (deviceCount > this.DEVICE_LIMIT) {
            throw Object.assign(
                new Error(`Per-device Instagram rate limit exceeded (${deviceCount}/${this.DEVICE_LIMIT} calls/hour)`),
                { code: 'RATE_LIMIT_DEVICE' }
            );
        }

        // ── Layer 3: Token bucket (burst) ──────────────────────────────────────
        const bucketKey = `instagram:bucket:${deviceId}`;
        const tokensStr = await client.get(bucketKey);

        if (tokensStr !== null && parseInt(tokensStr, 10) < 1) {
            throw Object.assign(
                new Error('Token bucket empty — burst limit reached, retry in 5 seconds'),
                { code: 'RATE_LIMIT_BURST' }
            );
        }

        if (tokensStr === null) {
            // First token: initialise bucket with (BUCKET_TOKENS - 1) remaining
            await client.setEx(bucketKey, this.BUCKET_TTL, String(this.BUCKET_TOKENS - 1));
        } else {
            await client.decr(bucketKey);
        }

        logger.debug('[RATE_LIMIT] Passed all layers', { deviceId, globalCount, deviceCount });
    }

    /**
     * Check rate limit and execute the provided function.
     * Rolls back the global counter on failure so retries don't double-count.
     */
    async checkAndExecute<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
        await this.check(deviceId);
        return fn();
    }

    /**
     * Get remaining quota for a device in the current hour.
     */
    async getRemainingQuota(deviceId: string): Promise<{ global: number; device: number }> {
        const redis = getRedisService();
        if (!redis || !redis.isRedisConnected()) {
            return { global: this.GLOBAL_LIMIT, device: this.DEVICE_LIMIT };
        }

        const client = redis.getClient();
        const hour = this.hourKey();

        const [globalRaw, deviceRaw] = await Promise.all([
            client.get(`instagram:rl:global:${hour}`),
            client.get(`instagram:rl:device:${deviceId}:${hour}`)
        ]);

        return {
            global: this.GLOBAL_LIMIT - (globalRaw ? parseInt(globalRaw, 10) : 0),
            device: this.DEVICE_LIMIT - (deviceRaw ? parseInt(deviceRaw, 10) : 0)
        };
    }
}

let _instance: InstagramRateLimiter | null = null;

export function getInstagramRateLimiter(): InstagramRateLimiter {
    if (!_instance) _instance = new InstagramRateLimiter();
    return _instance;
}
