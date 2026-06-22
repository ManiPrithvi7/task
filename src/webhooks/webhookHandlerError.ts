import { Response } from 'express';
import { logger } from '../utils/logger';

export function respondWebhookHandlerError(res: Response, logLabel: string, error: unknown): void {
  logger.error(`[${logLabel}] Error`, {
    error: error instanceof Error ? error.message : String(error)
  });
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: error instanceof Error ? error.message : 'Unknown error'
  });
}
