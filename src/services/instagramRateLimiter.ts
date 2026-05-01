/**
 * Extra safety layer for Instagram API calls.
 *
 * The real queue protection is enforced BEFORE enqueueing Kafka fetch requests
 * (Redis sliding-window backoff in `InstagramPoller`). This limiter exists as a
 * secondary guardrail in the consumer path.
 */

export type InstagramRateLimiter = {
  check: (deviceId: string) => Promise<void>;
};

let limiterSingleton: InstagramRateLimiter | null = null;

export function getInstagramRateLimiter(): InstagramRateLimiter {
  if (limiterSingleton) return limiterSingleton;

  limiterSingleton = {
    async check(_deviceId: string): Promise<void> {
      // No-op by default; poller enforces backoff before Kafka enqueue.
      return;
    }
  };

  return limiterSingleton;
}

