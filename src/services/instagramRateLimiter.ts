/**
 * Extra safety layer for Instagram API calls.
 *
 * The real queue protection is enforced BEFORE invoking the serverless Instagram fetch
 * (Redis sliding-window backoff in `InstagramPoller`). This limiter exists as an optional guardrail.
 */

export type InstagramRateLimiter = {
  check: (deviceId: string) => Promise<void>;
};

let limiterSingleton: InstagramRateLimiter | null = null;

export function getInstagramRateLimiter(): InstagramRateLimiter {
  if (limiterSingleton) return limiterSingleton;

  limiterSingleton = {
    async check(_deviceId: string): Promise<void> {
      // No-op by default; poller enforces backoff before serverless invoke.
      return;
    }
  };

  return limiterSingleton;
}

