import { Router, Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { AuthService } from '../services/authService';
import { getInfluxService } from '../services/influxService';
import { Provider } from '../models/Social';
import { GoogleBusinessLocation } from '../models/GoogleBusinessLocation';
import { fetchInstagramProfileMetrics } from '../lib/socials/instagramMetrics';
import { gmb } from '../lib/socials/integrations';
import { logger } from '../utils/logger';
import { parseConnectProvider, parseConnectAction } from '../utils/parseConnectProvider';
import type { IntegrationConnectAction } from '../utils/parseConnectProvider';
import {
  applyIntegrationConnectCache,
  applyIntegrationDisconnectCache
} from '../services/integrationConnectCache';
import { findOwnedSocial, socialOwnerId } from '../lib/socials/findOwnedSocial';

export type IntegrationStatusChangedMeta = {
  provider: Provider;
  action: IntegrationConnectAction;
};

export interface IntegrationRoutesDeps {
  authService: AuthService;
  /** Live IG/GMB screen pull (connect) or zeroed screen (disconnect). Must not fail HTTP. */
  onStatusChanged?: (deviceId: string, meta: IntegrationStatusChangedMeta) => void;
  applyDisconnectCache?: typeof applyIntegrationDisconnectCache;
  applyConnectCache?: typeof applyIntegrationConnectCache;
}

/** JWT `userId`/`sub` is the Business id. */
async function requireAuth(
  req: Request,
  res: Response,
  authService: AuthService
): Promise<{ userId: string } | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    logger.warn('[INTEGRATIONS_CONNECT] Auth failed', { code: 'AUTH_TOKEN_MISSING' });
    res.status(401).json({ error: 'Authorization required', code: 'AUTH_TOKEN_MISSING' });
    return null;
  }
  const token = authHeader.substring(7);
  const result = await authService.verifyAuthToken(token);
  if (!result.valid || !result.userId) {
    logger.warn('[INTEGRATIONS_CONNECT] Auth failed', { code: 'AUTH_TOKEN_INVALID' });
    res.status(401).json({ error: result.error || 'Invalid token', code: 'AUTH_TOKEN_INVALID' });
    return null;
  }
  return { userId: result.userId };
}

function notifyStatusChanged(
  deps: IntegrationRoutesDeps,
  deviceIds: string[],
  meta: IntegrationStatusChangedMeta
): void {
  for (const deviceId of deviceIds) {
    try {
      deps.onStatusChanged?.(deviceId, meta);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[INTEGRATIONS_CONNECT] onStatusChanged failed', { deviceId, error: msg });
    }
  }
}

export function createIntegrationRoutes(deps: IntegrationRoutesDeps): Router {
  const router = Router();
  const applyConnectCache = deps.applyConnectCache ?? applyIntegrationConnectCache;
  const applyDisconnectCache = deps.applyDisconnectCache ?? applyIntegrationDisconnectCache;

  /**
   * @swagger
   * /api/v1/integrations/connect:
   *   post:
   *     tags: [Integrations]
   *     summary: Capture social profile baseline on connect, or clear caches on disconnect
   *     description: >
   *       Connect fetches live Instagram or GMB metrics, writes a profile_baseline point
   *       to Influx, updates session caches, then live-pulls device screens.
   *       Disconnect (action=disconnect) skips Influx/upstream fetch, removes Redis profile
   *       fields, and immediately publishes a zeroed screen payload.
   *     security:
   *       - BearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/IntegrationConnectRequest'
   *     responses:
   *       200:
   *         description: Provider disconnected and caches cleared
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/IntegrationDisconnectResponse'
   *       201:
   *         description: Baseline captured
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/IntegrationConnectResponse'
   *       400:
   *         description: Missing fields or unsupported provider
   *       401:
   *         $ref: '#/components/responses/Unauthorized'
   *       404:
   *         $ref: '#/components/responses/NotFound'
   *       502:
   *         description: Upstream social API fetch failed
   *       503:
   *         $ref: '#/components/responses/ServiceUnavailable'
   *       500:
   *         $ref: '#/components/responses/InternalError'
   */
  router.post('/integrations/connect', async (req: Request, res: Response) => {
    const auth = await requireAuth(req, res, deps.authService);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      socialAccountId?: string;
      provider?: string;
      action?: unknown;
      connected?: unknown;
      event?: unknown;
    };
    const action = parseConnectAction(body);
    const { socialAccountId, provider: providerRaw } = body;

    if (!providerRaw) {
      logger.warn('[INTEGRATIONS_CONNECT] Missing fields', { userId: auth.userId, action });
      res.status(400).json({
        error: action === 'disconnect' ? 'provider required' : 'socialAccountId and provider required',
        code: 'FIELDS_REQUIRED'
      });
      return;
    }

    const provider = parseConnectProvider(providerRaw);
    if (!provider) {
      logger.warn('[INTEGRATIONS_CONNECT] Unsupported provider', {
        userId: auth.userId,
        provider: providerRaw
      });
      res.status(400).json({ error: `Unsupported provider: ${providerRaw}`, code: 'UNSUPPORTED_PROVIDER' });
      return;
    }

    if (action === 'disconnect') {
      logger.info('[INTEGRATIONS_DISCONNECT] Request', {
        userId: auth.userId,
        socialAccountId,
        provider
      });
      try {
        const { onlineDeviceIds } = await applyDisconnectCache({
          userId: auth.userId,
          provider,
          socialAccountId
        });
        res.status(200).json({ success: true, disconnected: true });
        notifyStatusChanged(deps, onlineDeviceIds, { provider, action: 'disconnect' });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('[INTEGRATIONS_DISCONNECT] Failed', { userId: auth.userId, error: msg });
        res.status(500).json({ error: 'Integration disconnect failed', detail: msg, code: 'INTERNAL_ERROR' });
      }
      return;
    }

    if (!socialAccountId) {
      logger.warn('[INTEGRATIONS_CONNECT] Missing fields', { userId: auth.userId, action });
      res.status(400).json({ error: 'socialAccountId and provider required', code: 'FIELDS_REQUIRED' });
      return;
    }

    logger.info('[INTEGRATIONS_CONNECT] Request', {
      userId: auth.userId,
      socialAccountId,
      provider
    });

    const influx = getInfluxService();
    if (!influx) {
      logger.warn('[INTEGRATIONS_CONNECT] Influx unavailable', { userId: auth.userId });
      res.status(503).json({ error: 'InfluxDB unavailable', code: 'INFLUXDB_UNAVAILABLE' });
      return;
    }

    try {
      const found = await findOwnedSocial({
        businessId: auth.userId,
        socialAccountId,
        provider
      });

      if (found.status === 'not_found') {
        res.status(404).json({ error: 'Social record not found', code: 'NOT_FOUND' });
        return;
      }

      const social = found.social;
      const ownerId = socialOwnerId(social, auth.userId);

      const now = new Date();
      let baseline: { followers: number; rating?: number; mediaCount?: number; username?: string };
      let gmbLocationId: string | undefined;

      if (social.provider === Provider.INSTAGRAM) {
        const profile = await fetchInstagramProfileMetrics(social.accessToken);
        if (!profile) {
          res.status(502).json({ error: 'Failed to fetch Instagram profile', code: 'FETCH_FAILED' });
          return;
        }
        baseline = {
          followers: profile.metrics.followers_count,
          mediaCount: profile.metrics.media_count,
          username: profile.metrics.username,
        };

        await influx.writeProfileBaseline({
          deviceId: socialAccountId,
          platform: 'instagram',
          followers: baseline.followers,
          connectedAt: now,
          timestamp: now,
        }, { flush: false });

      } else if (social.provider === Provider.GOOGLE_BUSINESS) {
        const locations = await GoogleBusinessLocation.find({ profileId: social._id }).lean();
        if (locations.length === 0) {
          logger.warn('[INTEGRATIONS_CONNECT] No GMB locations', {
            userId: auth.userId,
            socialAccountId
          });
          res.status(404).json({ error: 'No GMB locations found for this social', code: 'NO_LOCATIONS' });
          return;
        }

        const client = new OAuth2Client();
        client.setCredentials({ access_token: social.accessToken });
        const gmbAuth = client as unknown as Parameters<typeof gmb.fetchGmbLocationSummary>[0];

        const location = locations[0];
        gmbLocationId = location.locationId;
        const summary = await gmb.fetchGmbLocationSummary(gmbAuth, location.locationId);
        if (!summary) {
          res.status(502).json({ error: 'Failed to fetch GMB location summary', code: 'FETCH_FAILED' });
          return;
        }

        baseline = {
          followers: summary.totalReviewCount ?? 0,
          rating: summary.averageRating,
        };

        await influx.writeProfileBaseline({
          deviceId: location.locationId,
          platform: 'gmb',
          reviews: baseline.followers,
          rating: baseline.rating,
          locationId: location.locationId,
          connectedAt: now,
          timestamp: now,
        }, { flush: false });

      } else {
        res.status(400).json({ error: `Unsupported provider: ${social.provider}`, code: 'UNSUPPORTED_PROVIDER' });
        return;
      }

      const { deviceIds } = await applyConnectCache({
        userId: ownerId,
        provider,
        socialAccountId,
        accessToken: social.accessToken,
        gmbLocationId
      });

      res.status(201).json({ success: true, baseline: { ...baseline, connectedAt: now.toISOString() } });
      notifyStatusChanged(deps, deviceIds, { provider, action: 'connect' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[INTEGRATIONS_CONNECT] Failed', { userId: auth.userId, error: msg });
      res.status(500).json({ error: 'Integration connect failed', detail: msg, code: 'INTERNAL_ERROR' });
    }
  });

  return router;
}
