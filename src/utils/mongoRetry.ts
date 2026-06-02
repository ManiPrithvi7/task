import { logger } from './logger';

const TRANSIENT_MONGO_PATTERNS = [
  'ReplicaSetNoPrimary',
  'MongoServerSelectionError',
  'MongoNetworkError',
  'Server selection timed out'
];

export function isTransientMongoError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  return TRANSIENT_MONGO_PATTERNS.some(
    (pattern) => message.includes(pattern) || name.includes(pattern)
  );
}

export async function withMongoRetry<T>(
  fn: () => Promise<T>,
  opts?: { maxRetries?: number; label?: string }
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 3;
  const label = opts?.label ?? 'mongo';

  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      if (!isTransientMongoError(err) || attempt >= maxRetries - 1) {
        throw err;
      }
      const delayMs = 1000 * Math.pow(2, attempt);
      logger.warn(`${label}: transient Mongo error, retrying`, {
        attempt: attempt + 1,
        maxRetries,
        delayMs,
        error: err instanceof Error ? err.message : String(err)
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
