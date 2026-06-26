import { Router, Request, Response, json, raw } from 'express';
import rateLimit from 'express-rate-limit';
import type { MqttClientManager } from '../servers/mqttClient';
import type { WebhookConfig } from '../config/webhookConfig';
import type { WebhookHandlerDeps } from '../webhooks/types';
import { handleShopifyWebhook } from '../webhooks/shopifyHandler';
import { handleSquareWebhook } from '../webhooks/squareHandler';
import { handleGmbWebhook } from '../webhooks/gmbHandler';
import type { OtaService } from '../services/otaService';
import mongoose from 'mongoose';
import { getRedisService } from '../services/redisService';
import { logger } from '../utils/logger';

const WEBHOOK_RAW_LIMIT = '1mb';

const captureRawBody = raw({
  type: '*/*',
  limit: WEBHOOK_RAW_LIMIT,
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
});

const shopifyLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many Shopify webhook requests' }
});

const squareLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many Square webhook requests' }
});

const gmbLimiter = rateLimit({
  windowMs: 60_000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many GMB webhook requests' }
});

const otaReleaseLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many OTA release webhook requests' }
});

function extractBearerToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.substring(7).trim();
}

export type OtaReleaseWebhookDeps = {
  secret: string;
  otaService: OtaService;
};

export type WebhookRoutesDeps = {
  mqttClient: MqttClientManager;
  topicRoot: string;
  webhookConfig: WebhookConfig;
  appEnv: string;
  otaReleaseWebhook?: OtaReleaseWebhookDeps;
};

export function createWebhookRoutes(deps: WebhookRoutesDeps): Router {
  const router = Router();

  if (deps.otaReleaseWebhook) {
    const { secret, otaService } = deps.otaReleaseWebhook;

    router.post(
      '/api/webhooks/ota-release',
      otaReleaseLimiter,
      json(),
      async (req: Request, res: Response) => {
        const token = extractBearerToken(req);
        if (!secret || !token || token !== secret) {
          res.status(401).json({
            success: false,
            error: 'Unauthorized',
            code: 'WEBHOOK_UNAUTHORIZED',
            timestamp: new Date().toISOString()
          });
          return;
        }

        const body = req.body || {};
        const version = String(body.version || '').trim();
        const objectKey = String(
          body.object_key || body.objectKey || body.s3_key || body.s3Key || ''
        ).trim();
        const sha256 = String(body.sha256 || '').trim();
        const signature = String(body.signature || '').trim();
        const sizeBytes =
          typeof body.size_bytes === 'number'
            ? body.size_bytes
            : body.size_bytes != null
              ? parseInt(String(body.size_bytes), 10)
              : undefined;
        const releasedAt = body.released_at ? String(body.released_at) : undefined;
        const broadcast = body.broadcast !== false;

        const result = await otaService.ingestRelease({
          version,
          objectKey,
          sha256,
          signature,
          sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : undefined,
          releasedAt,
          broadcast
        });

        if (!result.ok) {
          res.status(result.httpStatus).json({
            success: false,
            error: result.error,
            code: result.code,
            timestamp: new Date().toISOString()
          });
          return;
        }

        logger.info('[OTA] CI webhook processed', {
          version: result.version,
          broadcast: result.broadcast,
          created: result.created
        });

        res.json({
          success: true,
          version: result.version,
          broadcast: result.broadcast,
          created: result.created,
          timestamp: new Date().toISOString()
        });
      }
    );
  }

  if (!deps.webhookConfig.enabled) {
    router.use((_req, res) => {
      res.status(503).json({
        error: 'Webhooks disabled',
        hint: 'Set WEBHOOK_ENABLED=true to enable ingress'
      });
    });
    return router;
  }

  const handlerDeps: WebhookHandlerDeps = {
    mqttClient: deps.mqttClient,
    topicRoot: deps.topicRoot,
    webhookConfig: deps.webhookConfig,
    appEnv: deps.appEnv
  };

  const wrap =
    (fn: (req: Request, res: Response, d: WebhookHandlerDeps) => Promise<void>) =>
    (req: Request, res: Response) => {
      void fn(req, res, handlerDeps);
    };

  /**
   * @swagger
   * /health/webhooks:
   *   get:
   *     tags: [Webhooks, Health]
   *     summary: Webhook subsystem readiness
   *     responses:
   *       200:
   *         description: Webhooks ready
   *       503:
   *         description: Redis, MongoDB, or MQTT not ready
   */
  router.get('/health/webhooks', (_req, res) => {
    const redis = getRedisService();
    const redisOk = redis?.isRedisConnected() === true;
    const mongoOk = mongoose.connection.readyState === 1;
    const mqttOk = deps.mqttClient.isConnected();
    const ready = redisOk && mongoOk && mqttOk;
    res.status(ready ? 200 : 503).json({
      ready,
      webhooks: {
        enabled: true,
        mqttPublish: deps.webhookConfig.mqttPublishEnabled,
        publicBaseUrl: deps.webhookConfig.publicBaseUrl || null
      },
      redis: redisOk,
      mongo: mongoOk,
      mqtt: mqttOk
    });
  });

  /**
   * @swagger
   * /api/pos-promotions/webhooks/shopify:
   *   post:
   *     tags: [Webhooks]
   *     summary: Shopify POS promotion webhook
   *     description: |
   *       Requires HMAC verification via X-Shopify-Hmac-Sha256 header against raw request body.
   *       Body is parsed from raw bytes before express.json().
   *     parameters:
   *       - in: header
   *         name: X-Shopify-Hmac-Sha256
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *     responses:
   *       200:
   *         description: Webhook accepted
   *       401:
   *         description: HMAC verification failed
   */
  router.post(
    '/api/pos-promotions/webhooks/shopify',
    shopifyLimiter,
    captureRawBody,
    wrap(handleShopifyWebhook)
  );

  /**
   * @swagger
   * /api/pos-promotions/webhooks/square:
   *   post:
   *     tags: [Webhooks]
   *     summary: Square POS promotion webhook
   *     description: |
   *       Requires Square webhook signature verification against raw request body.
   *     parameters:
   *       - in: header
   *         name: x-square-hmacsha256-signature
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *     responses:
   *       200:
   *         description: Webhook accepted
   *       401:
   *         description: Signature verification failed
   */
  router.post(
    '/api/pos-promotions/webhooks/square',
    squareLimiter,
    captureRawBody,
    wrap(handleSquareWebhook)
  );

  /**
   * @swagger
   * /api/webhooks/google-business-reviews:
   *   post:
   *     tags: [Webhooks]
   *     summary: Google Business reviews Pub/Sub push
   *     description: |
   *       Google Cloud Pub/Sub push envelope. Verified via Pub/Sub JWT / subscription config.
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               message:
   *                 type: object
   *               subscription:
   *                 type: string
   *     responses:
   *       200:
   *         description: Push accepted
   *       401:
   *         description: Pub/Sub verification failed
   */
  router.post(
    '/api/webhooks/google-business-reviews',
    gmbLimiter,
    captureRawBody,
    wrap(handleGmbWebhook)
  );

  logger.info('Webhook ingress routes registered', {
    shopify: '/api/pos-promotions/webhooks/shopify',
    square: '/api/pos-promotions/webhooks/square',
    gmb: '/api/webhooks/google-business-reviews',
    otaRelease: deps.otaReleaseWebhook ? '/api/webhooks/ota-release' : null,
    mqttPublish: deps.webhookConfig.mqttPublishEnabled,
    deviceTarget: deps.webhookConfig.deviceTarget
  });

  return router;
}
