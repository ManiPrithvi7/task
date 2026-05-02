import { RedisClientType } from 'redis';
import { REDIS_KEYS } from './instagramPollingLua';
import { igPollMetricsInc } from './instagramPollingMetrics';

/**
 * Cross-instance circuit breaker coordinated via Redis.
 * Backed by key: instagram:circuit:blocked_until (epoch ms string).
 *
 * Local caching reduces Redis reads during tight loops.
 */
export class InstagramCircuitBreaker {
  private redis: RedisClientType;
  private local: { isOpen: boolean; resetTimeMs: number } = { isOpen: false, resetTimeMs: 0 };
  private lastRedisCheckMs = 0;

  constructor(redis: RedisClientType, private readonly cacheTtlMs = 5000) {
    this.redis = redis;
  }

  async isOpen(): Promise<boolean> {
    const now = Date.now();

    if (now - this.lastRedisCheckMs < this.cacheTtlMs) {
      return this.local.isOpen && now < this.local.resetTimeMs;
    }

    const blockedUntilRaw = await this.redis.get(REDIS_KEYS.circuitBlockedUntil);
    this.lastRedisCheckMs = now;

    const blockedUntil = blockedUntilRaw ? parseInt(blockedUntilRaw, 10) : 0;
    if (blockedUntil && blockedUntil > now) {
      this.local = { isOpen: true, resetTimeMs: blockedUntil };
      return true;
    }

    this.local = { isOpen: false, resetTimeMs: 0 };
    return false;
  }

  async open(retryAfterSeconds: number): Promise<void> {
    const safeSeconds = Math.max(1, Math.floor(retryAfterSeconds));
    const resetTimeMs = Date.now() + safeSeconds * 1000;

    // Keep key slightly longer than the block window so stragglers observe it.
    await this.redis.set(REDIS_KEYS.circuitBlockedUntil, String(resetTimeMs), {
      EX: safeSeconds + 60
    });

    igPollMetricsInc('circuitOpenEvents');
    this.local = { isOpen: true, resetTimeMs };
    this.lastRedisCheckMs = Date.now();
  }

  async reset(): Promise<void> {
    await this.redis.del(REDIS_KEYS.circuitBlockedUntil);
    this.local = { isOpen: false, resetTimeMs: 0 };
    this.lastRedisCheckMs = Date.now();
  }

  /** Exposes cached state for health/debug endpoints without extra Redis calls. */
  getLocalState(): { isOpen: boolean; resetTimeMs: number } {
    return { ...this.local };
  }
}

