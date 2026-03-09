/**
 * Retry helper for Kafka connection attempts.
 * Used by KafkaService and Instagram consumers to avoid log spam and allow broker to become ready.
 */

import { logger } from './logger';

export const KAFKA_CONNECT_MAX_RETRIES = 5;
export const KAFKA_CONNECT_INITIAL_DELAY_MS = 2000;
export const KAFKA_CONNECT_MAX_DELAY_MS = 15000;

/**
 * Runs an async connect function with exponential backoff retry.
 * @param connectFn - Function that performs the connection (e.g. () => producer.connect())
 * @param label - Label for logs (e.g. 'Kafka producer', 'instagram-fetch-consumer')
 */
export async function connectWithRetry(
  connectFn: () => Promise<void>,
  label: string
): Promise<void> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= KAFKA_CONNECT_MAX_RETRIES; attempt++) {
    try {
      await connectFn();
      if (attempt > 1) {
        logger.info(`${label} connected after ${attempt} attempt(s)`);
      }
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const delayMs = Math.min(
        KAFKA_CONNECT_INITIAL_DELAY_MS * Math.pow(2, attempt - 1),
        KAFKA_CONNECT_MAX_DELAY_MS
      );
      logger.warn(`${label} connection attempt failed, retrying`, {
        attempt,
        maxRetries: KAFKA_CONNECT_MAX_RETRIES,
        nextRetryMs: delayMs,
        error: lastError.message
      });
      if (attempt < KAFKA_CONNECT_MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError ?? new Error(`${label} connect failed after ${KAFKA_CONNECT_MAX_RETRIES} attempts`);
}
