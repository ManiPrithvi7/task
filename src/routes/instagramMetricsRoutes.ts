import { Router, Request, Response } from 'express';
import { AuthService } from '../services/authService';
import {
  getInstagramMetricsCurrent,
  getInstagramMetricsHistory
} from '../services/instagramMetricsReadService';
import { onInstagramDisconnected } from '../services/igIntegrationLifecycle';
import { Provider } from '../models/Social';

export interface InstagramMetricsRoutesDeps {
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

function parseRange(raw: unknown): '30d' | '90d' | null {
  if (raw === '30d' || raw === '90d') return raw;
  return null;
}

export function createInstagramMetricsRoutes(deps: InstagramMetricsRoutesDeps): Router {
  const router = Router();

  router.get('/instagram/metrics/current', async (req: Request, res: Response) => {
    const auth = await requireAuth(req, res, deps.authService);
    if (!auth) return;

    const queryUserId = typeof req.query.userId === 'string' ? req.query.userId.trim() : '';
    const socialId = typeof req.query.socialId === 'string' ? req.query.socialId.trim() : '';
    const userId = queryUserId || auth.userId;

    if (queryUserId && queryUserId !== auth.userId) {
      res.status(403).json({ error: 'userId mismatch', code: 'USER_FORBIDDEN' });
      return;
    }

    if (!userId && !socialId) {
      res.status(400).json({ error: 'userId or socialId required', code: 'FIELDS_REQUIRED' });
      return;
    }

    try {
      const result = await getInstagramMetricsCurrent({
        userId: userId || undefined,
        socialId: socialId || undefined
      });
      if (!result) {
        res.status(404).json({ error: 'Instagram metrics not found', code: 'NOT_FOUND' });
        return;
      }
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'Metrics query failed', detail: msg });
    }
  });

  router.get('/instagram/metrics/history', async (req: Request, res: Response) => {
    const auth = await requireAuth(req, res, deps.authService);
    if (!auth) return;

    const queryUserId = typeof req.query.userId === 'string' ? req.query.userId.trim() : '';
    const socialId = typeof req.query.socialId === 'string' ? req.query.socialId.trim() : '';
    const range = parseRange(req.query.range);
    const userId = queryUserId || auth.userId;

    if (queryUserId && queryUserId !== auth.userId) {
      res.status(403).json({ error: 'userId mismatch', code: 'USER_FORBIDDEN' });
      return;
    }

    if (!range) {
      res.status(400).json({ error: 'range must be 30d or 90d', code: 'INVALID_RANGE' });
      return;
    }

    if (!userId && !socialId) {
      res.status(400).json({ error: 'userId or socialId required', code: 'FIELDS_REQUIRED' });
      return;
    }

    try {
      const result = await getInstagramMetricsHistory({
        userId: userId || undefined,
        socialId: socialId || undefined,
        range
      });
      if (!result) {
        res.status(404).json({ error: 'Instagram history not found', code: 'NOT_FOUND' });
        return;
      }
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'History query failed', detail: msg });
    }
  });

  router.post('/integrations/disconnect', async (req: Request, res: Response) => {
    const auth = await requireAuth(req, res, deps.authService);
    if (!auth) return;

    const providerRaw = typeof req.body?.provider === 'string' ? req.body.provider.trim() : '';
    if (providerRaw !== Provider.INSTAGRAM && providerRaw !== 'INSTAGRAM') {
      res.status(400).json({ error: 'Only INSTAGRAM disconnect supported here', code: 'UNSUPPORTED_PROVIDER' });
      return;
    }

    try {
      await onInstagramDisconnected(auth.userId);
      res.json({ success: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'Disconnect failed', detail: msg });
    }
  });

  return router;
}
