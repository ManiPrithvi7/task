import { Router, Request, Response, json, raw } from 'express';
import rateLimit from 'express-rate-limit';
import type { MqttClientManager } from '../servers/mqttClient';
import type { WebhookConfig } from '../config/webhookConfig';
import type { WebhookHandlerDeps } from '../webhooks/types';
import { handleGmbWebhook } from '../webhooks/gmbHandler';
import type { OtaService } from '../services/otaService';
import mongoose from 'mongoose';
import { getRedisService } from '../services/redisService';
import { logger } from '../utils/logger';
import { safeEqualString } from '../utils/safeEqual';
import { tryClaimWebhookDedupe } from '../webhooks/dedupe/redisDedupe';

const WEBHOOK_RAW_LIMIT = '1mb';

const captureRawBody = raw({
  type: '*/*',
  limit: WEBHOOK_RAW_LIMIT,
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
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
        if (!secret || !token || !safeEqualString(token, secret)) {
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

        const dedupeKey = `ota-release:${version}:${sha256}`;
        if (version && sha256) {
          const claimed = await tryClaimWebhookDedupe(dedupeKey);
          if (!claimed) {
            res.status(200).json({
              success: true,
              duplicate: true,
              version,
              timestamp: new Date().toISOString()
            });
            return;
          }
        }

        const sizeBytes =
          typeof body.size_bytes === 'number'
            ? body.size_bytes
            : body.size_bytes != null
              ? parseInt(String(body.size_bytes), 10)
              : undefined;
        const releasedAt = body.released_at ? String(body.released_at) : undefined;
        const rolloutBody = body.rollout && typeof body.rollout === 'object' ? body.rollout : undefined;
        const rollout = rolloutBody
          ? {
              strategy: rolloutBody.strategy != null ? String(rolloutBody.strategy) : undefined,
              percentage:
                typeof rolloutBody.percentage === 'number'
                  ? rolloutBody.percentage
                  : rolloutBody.percentage != null
                    ? parseInt(String(rolloutBody.percentage), 10)
                    : undefined,
              deviceIds: Array.isArray(rolloutBody.deviceIds)
                ? rolloutBody.deviceIds.map(String)
                : undefined
            }
          : undefined;

        // broadcast is ignored — rollout is sole push authority
        if (body.broadcast !== undefined) {
          logger.warn('[OTA] ota-release broadcast field ignored', {
            broadcast: body.broadcast,
            percentage: rollout?.percentage
          });
        }

        const result = await otaService.ingestRelease({
          version,
          objectKey,
          sha256,
          signature,
          sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : undefined,
          releasedAt,
          broadcast: body.broadcast === true ? true : undefined,
          rollout
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
          created: result.created,
          currentPercentage: result.currentPercentage
        });

        res.json({
          success: true,
          version: result.version,
          created: result.created,
          current_percentage: result.currentPercentage,
          timestamp: new Date().toISOString()
        });
      }
    );

    router.post(
      '/api/webhooks/ota-rollout-advance',
      otaReleaseLimiter,
      json(),
      async (req: Request, res: Response) => {
        const token = extractBearerToken(req);
        if (!secret || !token || !safeEqualString(token, secret)) {
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
        const percentageRaw = body.rollout?.percentage ?? body.percentage;
        const percentage =
          typeof percentageRaw === 'number'
            ? percentageRaw
            : percentageRaw != null
              ? parseInt(String(percentageRaw), 10)
              : undefined;

        if (!version) {
          res.status(400).json({
            success: false,
            error: 'version is required',
            code: 'MISSING_VERSION',
            timestamp: new Date().toISOString()
          });
          return;
        }

        const result = await otaService.advanceRollout(
          version,
          Number.isFinite(percentage) ? percentage : undefined
        );

        if (!result.ok) {
          res.status(result.httpStatus).json({
            success: false,
            error: result.error,
            code: result.code,
            timestamp: new Date().toISOString()
          });
          return;
        }

        res.json({
          success: true,
          version: result.version,
          current_percentage: result.currentPercentage,
          previous_percentage: result.previousPercentage,
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
  router.get('/health/webhooks', (req, res) => {
    const internalSecret = process.env.INTERNAL_HEALTH_SECRET;
    const ip = req.ip || req.socket.remoteAddress || '';
    const isLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
    const isInternal =
      isLoopback ||
      (Boolean(internalSecret) && req.headers['x-internal-health'] === internalSecret);
    if (!isInternal) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

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
    gmb: '/api/webhooks/google-business-reviews',
    otaRelease: deps.otaReleaseWebhook ? '/api/webhooks/ota-release' : null,
    otaRolloutAdvance: deps.otaReleaseWebhook ? '/api/webhooks/ota-rollout-advance' : null,
    mqttPublish: deps.webhookConfig.mqttPublishEnabled,
    deviceTarget: deps.webhookConfig.deviceTarget
  });

  return router;
}
