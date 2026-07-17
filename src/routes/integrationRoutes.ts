import { Router, Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { AuthService } from '../services/authService';
import { getInfluxService } from '../services/influxService';
import { Social, Provider } from '../models/Social';
import { GoogleBusinessLocation } from '../models/GoogleBusinessLocation';
import { fetchInstagramProfileMetrics } from '../lib/socials/instagramMetrics';
import { gmb } from '../lib/socials/integrations';
import { logger } from '../utils/logger';

export interface IntegrationRoutesDeps {
  authService: AuthService;
}

async function requireAuth(
  req: Request,
  res: Response,
  authService: AuthService
): Promise<{ userId: string } | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authorization required', code: 'AUTH_TOKEN_MISSING' });
    return null;
  }
  const token = authHeader.substring(7);
  const result = await authService.verifyAuthToken(token);
  if (!result.valid || !result.userId) {
    res.status(401).json({ error: result.error || 'Invalid token', code: 'AUTH_TOKEN_INVALID' });
    return null;
  }
  return { userId: result.userId };
}

const PROVIDER_MAP: Record<string, Provider> = {
  INSTAGRAM: Provider.INSTAGRAM,
  GOOGLE_BUSINESS: Provider.GOOGLE_BUSINESS,
};

export function createIntegrationRoutes(deps: IntegrationRoutesDeps): Router {
  const router = Router();

  /**
   * @swagger
   * /api/v1/integrations/connect:
   *   post:
   *     tags: [Integrations]
   *     summary: Capture social profile baseline on connect
   *     description: >
   *       Fetches live Instagram or GMB metrics, writes a profile_baseline point
   *       to Influx, and marks the Social record as baselineCaptured.
   *     security:
   *       - BearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/IntegrationConnectRequest'
   *     responses:
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
   *       409:
   *         description: Baseline already captured
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

    const { socialAccountId, provider: providerRaw } = req.body as { socialAccountId?: string; provider?: string };
    if (!socialAccountId || !providerRaw) {
      res.status(400).json({ error: 'socialAccountId and provider required', code: 'FIELDS_REQUIRED' });
      return;
    }

    const provider = PROVIDER_MAP[providerRaw];
    if (!provider) {
      res.status(400).json({ error: `Unsupported provider: ${providerRaw}`, code: 'UNSUPPORTED_PROVIDER' });
      return;
    }

    const influx = getInfluxService();
    if (!influx) {
      res.status(503).json({ error: 'InfluxDB unavailable', code: 'INFLUXDB_UNAVAILABLE' });
      return;
    }

    try {
      const social = await Social.findOne({
        userId: auth.userId,
        socialAccountId,
        provider,
      }).lean();

      if (!social) {
        res.status(404).json({ error: 'Social record not found', code: 'NOT_FOUND' });
        return;
      }

      if (social.baselineCaptured) {
        res.status(409).json({
          error: 'Baseline already captured',
          code: 'BASELINE_ALREADY_CAPTURED',
          baselineCapturedAt: social.baselineCapturedAt,
        });
        return;
      }

      const now = new Date();
      let baseline: { followers: number; rating?: number; mediaCount?: number; username?: string };

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
          userId: auth.userId,
          followers: baseline.followers,
          connectedAt: now,
          timestamp: now,
        }, { flush: false });

      } else if (social.provider === Provider.GOOGLE_BUSINESS) {
        const locations = await GoogleBusinessLocation.find({ profileId: social._id }).lean();
        if (locations.length === 0) {
          res.status(404).json({ error: 'No GMB locations found for this social', code: 'NO_LOCATIONS' });
          return;
        }

        const client = new OAuth2Client();
        client.setCredentials({ access_token: social.accessToken });
        const gmbAuth = client as unknown as Parameters<typeof gmb.fetchGmbLocationSummary>[0];

        const location = locations[0];
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
          userId: auth.userId,
          followers: baseline.followers,
          rating: baseline.rating,
          connectedAt: now,
          timestamp: now,
        }, { flush: false });

      } else {
        res.status(400).json({ error: `Unsupported provider: ${social.provider}`, code: 'UNSUPPORTED_PROVIDER' });
        return;
      }

      await Social.updateOne(
        { _id: social._id },
        { $set: { baselineCaptured: true, baselineCapturedAt: now } },
      );

      res.status(201).json({ success: true, baseline: { ...baseline, connectedAt: now.toISOString() } });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[INTEGRATIONS_CONNECT] Failed', { userId: auth.userId, error: msg });
      res.status(500).json({ error: 'Integration connect failed', detail: msg, code: 'INTERNAL_ERROR' });
    }
  });

  return router;
}
