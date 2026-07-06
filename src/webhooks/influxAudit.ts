import type { InfluxService } from '../services/influxService';
import { getInfluxService } from '../services/influxService';
import { logger } from '../utils/logger';

/** Run webhook Influx writes when service is configured. Never auto-flushes. */
export async function webhookInfluxBatch(fn: (influx: InfluxService) => Promise<void>): Promise<void> {
  const influx = getInfluxService();
  if (!influx) {
    logger.error('[WEBHOOK_INFLUX] Influx service unavailable — audit write skipped');
    return;
  }
  try {
    await fn(influx);
  } catch (err: unknown) {
    logger.error('[WEBHOOK_INFLUX] write failed', {
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/** Flush buffered webhook writes before HTTP response. */
export async function flushWebhookInflux(): Promise<void> {
  const influx = getInfluxService();
  if (!influx) return;
  try {
    await influx.flushWrites();
  } catch (err: unknown) {
    logger.error('[WEBHOOK_INFLUX] flush failed', {
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
