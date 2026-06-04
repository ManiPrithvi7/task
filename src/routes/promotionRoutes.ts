import { Router, Request, Response } from 'express';
import { resolvePromotionInvalidateApiKey } from '../config/promotionConfig';
import { invalidateAndFanout } from '../services/promotionService';
import type { StatsPublisher } from '../services/statsPublisher';
import { logger } from '../utils/logger';

export type PromotionRoutesDeps = {
  statsPublisher: StatsPublisher;
  topicRoot: string;
};

export function createPromotionRoutes(deps: PromotionRoutesDeps): Router {
  const router = Router();

  router.post('/promotions/invalidate-cache', async (req: Request, res: Response) => {
    const expectedKey = resolvePromotionInvalidateApiKey();
    const providedKey = req.headers['x-api-key'];
    const keyStr = typeof providedKey === 'string' ? providedKey : '';

    if (!expectedKey || keyStr !== expectedKey) {
      res.status(401).json({ error: 'Invalid or missing API key' });
      return;
    }

    const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
    if (!userId) {
      res.status(400).json({ error: 'userId required' });
      return;
    }

    try {
      const result = await invalidateAndFanout(userId, {
        topicRoot: deps.topicRoot,
        publishForDevice: (deviceId, topicRoot) =>
          deps.statsPublisher.publishPromotionForDevice(deviceId, topicRoot)
      });
      res.status(200).json(result);
    } catch (err: unknown) {
      logger.error('[PROMO_INVALIDATE] Handler failed', {
        userId,
        error: err instanceof Error ? err.message : String(err)
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
