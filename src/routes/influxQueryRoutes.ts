import { Router, Request, Response } from 'express';
import { AuthService } from '../services/authService';
import { getInfluxService } from '../services/influxService';
import { sanitizeFluxQuery, MAX_RESULTS, MAX_EXECUTION_MS } from '../middleware/querySanitizer';
import { logger } from '../utils/logger';

/** Legacy measurements — log proxy access before removal. */
const LEGACY_MEASUREMENTS = new Set([
  'device_metrics',
  'system_metrics',
  'social_metrics',
  'rate_limit_events',
  'instagram_circuit_event',
  'velocity_weekly',
  'gmb_velocity_weekly',
  'webhook_mqtt_delivery',
  'instagram_mqtt_delivery',
  'milestone_crossed',
]);

export interface InfluxQueryRoutesDeps {
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

async function requireAdmin(
  req: Request,
  res: Response,
  authService: AuthService
): Promise<{ userId: string } | null> {
  const auth = await requireAuth(req, res, authService);
  if (!auth) return null;

  const authHeader = req.headers.authorization!;
  const token = authHeader.substring(7);
  const result = await authService.verifyAuthToken(token);
  const role = typeof result.decoded?.role === 'string' ? result.decoded.role : undefined;
  if (role !== 'admin') {
    res.status(403).json({ error: 'Admin access required for compliance scope', code: 'ADMIN_REQUIRED' });
    return null;
  }
  return auth;
}

export function createInfluxQueryRoutes(deps: InfluxQueryRoutesDeps): Router {
  const router = Router();

  /**
   * @swagger
   * /api/v1/influx/query:
   *   post:
   *     tags: [Influx]
   *     summary: Proxy a Flux query to InfluxDB
   *     description: >
   *       Executes a sanitized Flux query. Scope `metrics` requires a user JWT;
   *       scope `compliance` requires an admin JWT. Queries without an explicit
   *       limit() are capped at 10000 rows.
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - in: header
   *         name: X-Query-Scope
   *         required: false
   *         schema:
   *           type: string
   *           enum: [metrics, compliance]
   *           default: metrics
   *         description: Bucket scope — compliance requires role=admin
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/InfluxQueryRequest'
   *     responses:
   *       200:
   *         description: Query results
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/InfluxQueryResponse'
   *       400:
   *         description: Invalid scope or rejected Flux query
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/SimpleError'
   *       401:
   *         $ref: '#/components/responses/Unauthorized'
   *       403:
   *         $ref: '#/components/responses/Forbidden'
   *       500:
   *         $ref: '#/components/responses/InternalError'
   *       503:
   *         $ref: '#/components/responses/ServiceUnavailable'
   */
  router.post('/influx/query', async (req: Request, res: Response) => {
    const scope = (req.headers['x-query-scope'] as string || 'metrics').toLowerCase();
    if (scope !== 'metrics' && scope !== 'compliance') {
      res.status(400).json({ error: 'Invalid X-Query-Scope. Must be "metrics" or "compliance".', code: 'INVALID_SCOPE' });
      return;
    }

    const authOk = scope === 'compliance'
      ? await requireAdmin(req, res, deps.authService)
      : await requireAuth(req, res, deps.authService);
    if (!authOk) return;

    const { flux } = req.body as { flux?: string };
    if (!flux) {
      res.status(400).json({ error: 'flux query required', code: 'QUERY_REQUIRED' });
      return;
    }

    const sanitized = sanitizeFluxQuery(flux, scope);
    if (!sanitized.valid) {
      res.status(400).json({ error: sanitized.error, code: 'QUERY_REJECTED' });
      return;
    }

    const measurementMatch = flux.match(/r\._measurement\s*==\s*"([^"]+)"/);
    if (measurementMatch && LEGACY_MEASUREMENTS.has(measurementMatch[1])) {
      logger.warn('Legacy Influx measurement queried via proxy', {
        measurement: measurementMatch[1],
        scope,
        ip: req.ip,
      });
    }

    const influx = getInfluxService();
    if (!influx) {
      res.status(503).json({ error: 'InfluxDB unavailable', code: 'INFLUXDB_UNAVAILABLE' });
      return;
    }

    const startTime = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), MAX_EXECUTION_MS);

      const fluxWithLimit = flux.includes('limit(') ? flux : `${flux.trim()}\n  |> limit(n: ${MAX_RESULTS})`;

      const results = await influx.queryFlux(fluxWithLimit, {
        signal: controller.signal,
        timeoutMs: MAX_EXECUTION_MS,
      });
      clearTimeout(timeout);

      const executionTimeMs = Date.now() - startTime;
      const truncated = results.length > MAX_RESULTS ? results.slice(0, MAX_RESULTS) : results;

      res.json({
        results: truncated,
        metadata: {
          rowCount: truncated.length,
          totalCount: results.length,
          executionTimeMs,
          truncated: results.length > MAX_RESULTS,
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'Query execution failed', detail: msg, code: 'QUERY_FAILED' });
    }
  });

  return router;
}
