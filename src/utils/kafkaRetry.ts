import { logger } from './logger';

export async function connectWithRetry<T>(
  fn: () => Promise<T>,
  label: string,
  opts?: { retries?: number; baseDelayMs?: number }
): Promise<T> {
  const retries = opts?.retries ?? 5;
  const baseDelayMs = opts?.baseDelayMs ?? 500;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const delay = Math.min(10_000, baseDelayMs * Math.pow(2, attempt));
      logger.warn(`[KAFKA] ${label} failed, retrying`, { attempt: attempt + 1, retries: retries + 1, delayMs: delay, error: msg });
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

