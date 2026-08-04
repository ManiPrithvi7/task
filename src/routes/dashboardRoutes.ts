import { Router, Request, Response } from 'express';
import { AuthService } from '../services/authService';
import { Device } from '../models/Device';
import { getInfluxService } from '../services/influxService';
import { cachedQuery } from '../services/influxQueryCache';

export interface DashboardRoutesDeps {
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

async function verifyDeviceOwnership(deviceId: string, userId: string): Promise<boolean> {
  const device = await Device.findOne({ clientId: deviceId }).select({ userId: 1 }).lean();
  return device?.userId?.toString() === userId;
}

const sanitizeForDashboard = (rows: Record<string, unknown>[]): Record<string, unknown>[] =>
  rows.map((r) => {
    const sanitized = { ...r };
    delete sanitized.primary_response_sha256;
    delete sanitized.details_response_sha256;
    delete sanitized.payload_sha256;
    return sanitized;
  });

export function createDashboardRoutes(deps: DashboardRoutesDeps): Router {
  const router = Router();

  /**
   * @swagger
   * /api/v1/dashboard/instagram/{deviceId}/summary:
   *   get:
   *     tags: [Dashboard]
   *     summary: Instagram dashboard summary for a device
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - in: path
   *         name: deviceId
   *         required: true
   *         schema: { type: string }
   *       - in: query
   *         name: range
   *         schema: { type: string, default: '-90d' }
   *         description: Flux range start (e.g. -7d, -90d)
   *     responses:
   *       200:
   *         description: Metrics, baseline, milestones, and weekly velocity
   *       401:
   *         $ref: '#/components/responses/Unauthorized'
   *       403:
   *         $ref: '#/components/responses/Forbidden'
   *       503:
   *         $ref: '#/components/responses/ServiceUnavailable'
   *       500:
   *         $ref: '#/components/responses/InternalError'
   */
  router.get('/dashboard/instagram/:deviceId/summary', async (req: Request, res: Response) => {
    const auth = await requireAuth(req, res, deps.authService);
    if (!auth) return;

    const { deviceId } = req.params;
    if (!(await verifyDeviceOwnership(deviceId, auth.userId))) {
      res.status(403).json({ error: 'Device not owned by user', code: 'DEVICE_NOT_OWNED' });
      return;
    }

    const influx = getInfluxService();
    if (!influx) {
      res.status(503).json({ error: 'InfluxDB unavailable', code: 'INFLUXDB_UNAVAILABLE' });
      return;
    }

    try {
      const range = req.query.range || '-90d';
      const cacheKey = `ig:summary:${deviceId}:${range}`;
      const result = await cachedQuery(
        cacheKey,
        async () => {
          const [metrics, baseline, milestones] = await Promise.all([
            influx.queryIgMetrics(deviceId, String(range)),
            influx.queryProfileBaseline(deviceId, 'instagram'),
            influx.queryIgMilestones(deviceId, String(range)),
          ]);
          return {
            metrics: sanitizeForDashboard(metrics),
            baseline,
            milestones: sanitizeForDashboard(milestones),
            velocity: sanitizeForDashboard(milestones),
          };
        },
        { freshMs: 30_000, staleMs: 120_000 }
      );

      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'Dashboard query failed', detail: msg });
    }
  });

  /**
   * @swagger
   * /api/v1/dashboard/gmb/{locationId}/summary:
   *   get:
   *     tags: [Dashboard]
   *     summary: GMB dashboard summary for a location
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - in: path
   *         name: locationId
   *         required: true
   *         schema: { type: string }
   *       - in: query
   *         name: range
   *         schema: { type: string, default: '-90d' }
   *     responses:
   *       200:
   *         description: Webhook events, review snapshots, baseline, milestones, velocity
   *       401:
   *         $ref: '#/components/responses/Unauthorized'
   *       503:
   *         $ref: '#/components/responses/ServiceUnavailable'
   *       500:
   *         $ref: '#/components/responses/InternalError'
   */
  router.get('/dashboard/gmb/:locationId/summary', async (req: Request, res: Response) => {
    const auth = await requireAuth(req, res, deps.authService);
    if (!auth) return;

    const { locationId } = req.params;
    const influx = getInfluxService();
    if (!influx) {
      res.status(503).json({ error: 'InfluxDB unavailable', code: 'INFLUXDB_UNAVAILABLE' });
      return;
    }

    try {
      const range = req.query.range || '-90d';
      const cacheKey = `gmb:summary:${locationId}:${range}`;
      const result = await cachedQuery(
        cacheKey,
        async () => {
          const [webhookAudits, gmbMetrics, baseline, milestones] = await Promise.all([
            influx.queryGmbWebhookAudits(locationId, String(range)),
            influx.queryGmbMetrics(locationId, String(range)),
            influx.queryProfileBaseline(locationId, 'gmb'),
            influx.queryGmbMilestones(locationId, String(range)),
          ]);
          return {
            webhook_events: sanitizeForDashboard(webhookAudits),
            review_snapshots: sanitizeForDashboard(gmbMetrics),
            baseline,
            milestones: sanitizeForDashboard(milestones),
            velocity: sanitizeForDashboard(milestones),
          };
        },
        { freshMs: 30_000, staleMs: 120_000 }
      );

      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'Dashboard query failed', detail: msg });
    }
  });

  /**
   * @swagger
   * /api/v1/dashboard/gmb/{locationId}/reviews:
   *   get:
   *     tags: [Dashboard]
   *     summary: GMB review snapshots for a location
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - in: path
   *         name: locationId
   *         required: true
   *         schema: { type: string }
   *       - in: query
   *         name: range
   *         schema: { type: string, default: '-90d' }
   *     responses:
   *       200:
   *         description: Review snapshots
   *       401:
   *         $ref: '#/components/responses/Unauthorized'
   *       503:
   *         $ref: '#/components/responses/ServiceUnavailable'
   *       500:
   *         $ref: '#/components/responses/InternalError'
   */
  router.get('/dashboard/gmb/:locationId/reviews', async (req: Request, res: Response) => {
    const auth = await requireAuth(req, res, deps.authService);
    if (!auth) return;

    const { locationId } = req.params;
    const influx = getInfluxService();
    if (!influx) {
      res.status(503).json({ error: 'InfluxDB unavailable', code: 'INFLUXDB_UNAVAILABLE' });
      return;
    }

    try {
      const range = req.query.range || '-90d';
      const snapshots = await influx.queryGmbMetrics(locationId, String(range));
      res.json({ review_snapshots: sanitizeForDashboard(snapshots) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'Review snapshots query failed', detail: msg });
    }
  });

  /**
   * @swagger
   * /api/v1/dashboard/gmb/{locationId}/velocity:
   *   get:
   *     tags: [Dashboard]
   *     summary: GMB weekly velocity for a location
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - in: path
   *         name: locationId
   *         required: true
   *         schema: { type: string }
   *       - in: query
   *         name: week
   *         schema: { type: string }
   *         description: Optional week_of_year filter
   *     responses:
   *       200:
   *         description: Weekly velocity rows
   *       401:
   *         $ref: '#/components/responses/Unauthorized'
   *       503:
   *         $ref: '#/components/responses/ServiceUnavailable'
   *       500:
   *         $ref: '#/components/responses/InternalError'
   */
  router.get('/dashboard/gmb/:locationId/velocity', async (req: Request, res: Response) => {
    const auth = await requireAuth(req, res, deps.authService);
    if (!auth) return;

    const { locationId } = req.params;
    const influx = getInfluxService();
    if (!influx) {
      res.status(503).json({ error: 'InfluxDB unavailable', code: 'INFLUXDB_UNAVAILABLE' });
      return;
    }

    try {
      const range = req.query.range || '-90d';
      const milestones = await influx.queryGmbMilestones(locationId, String(range));
      res.json({ velocity: sanitizeForDashboard(milestones) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'Velocity query failed', detail: msg });
    }
  });

  /**
   * @swagger
   * /api/v1/dashboard/gmb/{locationId}/webhooks:
   *   get:
   *     tags: [Dashboard]
   *     summary: GMB webhook audit and MQTT delivery trail
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - in: path
   *         name: locationId
   *         required: true
   *         schema: { type: string }
   *       - in: query
   *         name: range
   *         schema: { type: string, default: '-7d' }
   *     responses:
   *       200:
   *         description: Webhook audits and MQTT deliveries
   *       401:
   *         $ref: '#/components/responses/Unauthorized'
   *       503:
   *         $ref: '#/components/responses/ServiceUnavailable'
   *       500:
   *         $ref: '#/components/responses/InternalError'
   */
  router.get('/dashboard/gmb/:locationId/webhooks', async (req: Request, res: Response) => {
    const auth = await requireAuth(req, res, deps.authService);
    if (!auth) return;

    const { locationId } = req.params;
    const influx = getInfluxService();
    if (!influx) {
      res.status(503).json({ error: 'InfluxDB unavailable', code: 'INFLUXDB_UNAVAILABLE' });
      return;
    }

    try {
      const range = req.query.range || '-7d';
      const audits = await influx.queryGmbWebhookAudits(locationId, String(range));
      const mqttDeliveries = await influx.queryMqttDeliveryByLocation(locationId, 'gmb', String(range));
      res.json({
        webhook_audits: sanitizeForDashboard(audits),
        mqtt_deliveries: sanitizeForDashboard(mqttDeliveries),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'Webhook audit query failed', detail: msg });
    }
  });

  /**
   * @swagger
   * /api/v1/dashboard/device/{deviceId}/audit:
   *   get:
   *     tags: [Dashboard]
   *     summary: Device Instagram/webhook audit trail
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - in: path
   *         name: deviceId
   *         required: true
   *         schema: { type: string }
   *       - in: query
   *         name: range
   *         schema: { type: string, default: '-7d' }
   *     responses:
   *       200:
   *         description: Fetch audits, MQTT deliveries, and attention e2e
   *       401:
   *         $ref: '#/components/responses/Unauthorized'
   *       403:
   *         $ref: '#/components/responses/Forbidden'
   *       503:
   *         $ref: '#/components/responses/ServiceUnavailable'
   *       500:
   *         $ref: '#/components/responses/InternalError'
   */
  router.get('/dashboard/device/:deviceId/audit', async (req: Request, res: Response) => {
    const auth = await requireAuth(req, res, deps.authService);
    if (!auth) return;

    const { deviceId } = req.params;
    if (!(await verifyDeviceOwnership(deviceId, auth.userId))) {
      res.status(403).json({ error: 'Device not owned by user', code: 'DEVICE_NOT_OWNED' });
      return;
    }

    const influx = getInfluxService();
    if (!influx) {
      res.status(503).json({ error: 'InfluxDB unavailable', code: 'INFLUXDB_UNAVAILABLE' });
      return;
    }

    try {
      const range = req.query.range || '-7d';
      const cacheKey = `device:audit:${deviceId}:${range}`;
      const result = await cachedQuery(
        cacheKey,
        async () => {
          const [igAudit, igMqtt, gmbMqtt, e2e] = await Promise.all([
            influx.queryInstagramAudit(deviceId, String(range)),
            influx.queryMqttDelivery(deviceId, 'instagram', String(range)),
            influx.queryMqttDelivery(deviceId, 'gmb', String(range)),
            influx.queryInstagramAttentionE2e(deviceId, String(range)),
          ]);
          return {
            instagram_fetch_audit: sanitizeForDashboard(igAudit),
            mqtt_delivery_instagram: sanitizeForDashboard(igMqtt),
            mqtt_delivery_gmb: sanitizeForDashboard(gmbMqtt),
            attention_e2e: sanitizeForDashboard(e2e),
          };
        },
        { freshMs: 15_000, staleMs: 60_000 }
      );

      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'Audit query failed', detail: msg });
    }
  });

  /**
   * @swagger
   * /api/v1/dashboard/device/{deviceId}/baseline:
   *   get:
   *     tags: [Dashboard]
   *     summary: Profile baselines (Instagram + GMB) for a device
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - in: path
   *         name: deviceId
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Latest baselines per platform
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DeviceBaselineResponse'
   *       401:
   *         $ref: '#/components/responses/Unauthorized'
   *       403:
   *         $ref: '#/components/responses/Forbidden'
   *       503:
   *         $ref: '#/components/responses/ServiceUnavailable'
   *       500:
   *         $ref: '#/components/responses/InternalError'
   */
  router.get('/dashboard/device/:deviceId/baseline', async (req: Request, res: Response) => {
    const auth = await requireAuth(req, res, deps.authService);
    if (!auth) return;

    const { deviceId } = req.params;
    if (!(await verifyDeviceOwnership(deviceId, auth.userId))) {
      res.status(403).json({ error: 'Device not owned by user', code: 'DEVICE_NOT_OWNED' });
      return;
    }

    const influx = getInfluxService();
    if (!influx) {
      res.status(503).json({ error: 'InfluxDB unavailable', code: 'INFLUXDB_UNAVAILABLE' });
      return;
    }

    try {
      const [igBaseline, gmbBaseline] = await Promise.all([
        influx.queryProfileBaseline(deviceId, 'instagram'),
        influx.queryProfileBaseline(deviceId, 'gmb'),
      ]);

      res.json({ instagram: igBaseline, gmb: gmbBaseline });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'Baseline query failed', detail: msg });
    }
  });

  return router;
}
