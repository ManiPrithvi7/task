import { Router, Request, Response, raw } from 'express';
import rateLimit from 'express-rate-limit';
import type { MqttClientManager } from '../servers/mqttClient';
import type { WebhookConfig } from '../config/webhookConfig';
import type { WebhookHandlerDeps } from '../webhooks/types';
import { handleShopifyWebhook } from '../webhooks/shopifyHandler';
import { handleSquareWebhook } from '../webhooks/squareHandler';
import { handleGmbWebhook } from '../webhooks/gmbHandler';
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

export type WebhookRoutesDeps = {
  mqttClient: MqttClientManager;
  topicRoot: string;
  webhookConfig: WebhookConfig;
  appEnv: string;
};

export function createWebhookRoutes(deps: WebhookRoutesDeps): Router {
  const router = Router();

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

  router.post(
    '/api/pos-promotions/webhooks/shopify',
    shopifyLimiter,
    captureRawBody,
    wrap(handleShopifyWebhook)
  );

  router.post(
    '/api/pos-promotions/webhooks/square',
    squareLimiter,
    captureRawBody,
    wrap(handleSquareWebhook)
  );

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
    mqttPublish: deps.webhookConfig.mqttPublishEnabled,
    deviceTarget: deps.webhookConfig.deviceTarget
  });

  return router;
}
