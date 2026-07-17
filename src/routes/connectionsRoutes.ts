import { Router, Request, Response } from 'express';
import { resolveConnectionsValidateApiKey } from '../config/connectionsConfig';
import {
  handleConnectionValidateEvent,
  type ConnectionValidateEvent
} from '../services/promotionService';
import { Provider } from '../models/Social';
import type { StatsPublisher } from '../services/statsPublisher';
import { logger } from '../utils/logger';

const VALID_EVENTS: ConnectionValidateEvent[] = [
  'social.connected',
  'social.disconnected',
  'campaign.updated',
  'campaign.deleted',
  'canvas.updated',
  'integrations.refresh'
];

const PROVIDER_MAP: Record<string, Provider> = {
  INSTAGRAM: Provider.INSTAGRAM,
  GOOGLE_BUSINESS: Provider.GOOGLE_BUSINESS
};

export type ConnectionsRoutesDeps = {
  statsPublisher: StatsPublisher;
  topicRoot: string;
};

export function createConnectionsRoutes(deps: ConnectionsRoutesDeps): Router {
  const router = Router();

  /**
   * @swagger
   * /api/v1/connections/validate:
   *   post:
   *     tags: [Connections]
   *     summary: Validate connection and fan out promotion updates
   *     security:
   *       - ApiKeyAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/ConnectionValidateRequest'
   *     responses:
   *       200:
   *         description: Event processed
   *       400:
   *         description: Invalid request
   *       401:
   *         $ref: '#/components/responses/Unauthorized'
   *       500:
   *         $ref: '#/components/responses/InternalError'
   */
  router.post('/connections/validate', async (req: Request, res: Response) => {
    const expectedKey = resolveConnectionsValidateApiKey();
    const providedKey = req.headers['x-api-key'];
    const keyStr = typeof providedKey === 'string' ? providedKey : '';

    if (!expectedKey || keyStr !== expectedKey) {
      res.status(401).json({ error: 'Invalid or missing API key' });
      return;
    }

    const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
    const event = req.body?.event as ConnectionValidateEvent;

    if (!userId) {
      res.status(400).json({ error: 'userId required' });
      return;
    }

    if (!event || !VALID_EVENTS.includes(event)) {
      res.status(400).json({
        error: 'Invalid event',
        validEvents: VALID_EVENTS
      });
      return;
    }

    const fanout = req.body?.fanout !== false;
    const providerRaw = typeof req.body?.provider === 'string' ? req.body.provider.trim() : '';
    const provider = providerRaw ? PROVIDER_MAP[providerRaw] : undefined;

    if (providerRaw && !provider) {
      res.status(400).json({ error: 'Invalid provider', validProviders: Object.keys(PROVIDER_MAP) });
      return;
    }

    try {
      const result = await handleConnectionValidateEvent(event, userId, {
        topicRoot: deps.topicRoot,
        publishForDevice: (deviceId, topicRoot, opts) =>
          deps.statsPublisher.publishPromotionForDevice(deviceId, topicRoot, opts)
      }, { fanout, provider });

      res.status(200).json(result);
    } catch (err: unknown) {
      logger.error('[CONNECTIONS_VALIDATE] Handler failed', {
        userId,
        event,
        error: err instanceof Error ? err.message : String(err)
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
