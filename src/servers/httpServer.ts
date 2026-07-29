import express, { Express, Request, Response, NextFunction, Router, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { createServer, Server } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { logger } from '../utils/logger';
import { setupSwaggerUi } from '../config/swagger';
import { correlationIdMiddleware } from '../middleware/correlationId';
import { metricsMiddleware, metricsHandler } from '../middleware/metrics';
import { SessionService } from '../services/sessionService';
import { DeviceService } from '../services/deviceService';
import { MqttClientManager } from './mqttClient';
import { getRedisService } from '../services/redisService';

export interface HttpConfig {
  port: number;
  host: string;
  requestLogging?: boolean;
  healthChecksEnabled?: boolean;
}

export class HttpServer {
  private app: Express;
  private server: Server | null = null;
  private config: HttpConfig;
  private sessionService: SessionService;
  private deviceService: DeviceService;
  private mqttClient: MqttClientManager;
  private readinessProvider?: () => Promise<Record<string, unknown>>;
  private earlyRouters: Router[];

  constructor(
    config: HttpConfig,
    sessionService: SessionService,
    deviceService: DeviceService,
    mqttClient: MqttClientManager,
    readinessProvider?: () => Promise<Record<string, unknown>>,
    earlyRouters: Router[] = []
  ) {
    this.config = config;
    this.sessionService = sessionService;
    this.deviceService = deviceService;
    this.mqttClient = mqttClient;
    this.readinessProvider = readinessProvider;
    this.earlyRouters = earlyRouters;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.set('trust proxy', 1);
    const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    this.app.use(
      cors({
        origin: allowedOrigins.length > 0 ? allowedOrigins : false,
        credentials: true
      })
    );
    this.app.use(helmet({
      contentSecurityPolicy: false
    }));
    this.app.use(compression() as unknown as RequestHandler);

    // Webhook HMAC routes must run before express.json() (raw body preserved).
    for (const router of this.earlyRouters) {
      this.app.use(router);
    }

    // Increase limit for sign-csr body (PEM CSR + token can be ~4–8kb)
    this.app.use(express.json({ limit: '512kb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '512kb' }));
    this.app.use(correlationIdMiddleware);
    this.app.use(metricsMiddleware);

    const globalLimiter = rateLimit({
      windowMs: parseInt(process.env.GLOBAL_RATE_LIMIT_WINDOW_MS || '900000', 10),
      max: parseInt(process.env.GLOBAL_RATE_LIMIT_MAX_REQUESTS || '1000', 10),
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        error: 'Too many requests',
        code: 'GLOBAL_RATE_LIMIT_EXCEEDED',
        timestamp: new Date().toISOString()
      },
      skip: (req) => {
        const path = req.path;
        if (path === '/health' || path === '/ready' || path === '/api/docs') {
          return true;
        }
        if (path.startsWith('/api/webhooks/')) {
          return true;
        }
        if (path === '/metrics') {
          return true;
        }
        if (path.startsWith('/api/v1/ota/download/')) {
          return true;
        }
        return false;
      }
    });

    if (this.config.requestLogging !== false) {
      this.app.use((req: Request, res: Response, next: NextFunction) => {
        const start = Date.now();
        res.on('finish', () => {
          const duration = Date.now() - start;
          const isHealthCheck = req.path === '/health' || req.path === '/health/';
          const logLevel = isHealthCheck ? 'debug' : 'info';

          if (logLevel === 'debug') {
            logger.debug('HTTP request', {
              method: req.method,
              path: req.path,
              status: res.statusCode,
              duration: `${duration}ms`
            });
          } else {
            logger.info('HTTP request', {
              method: req.method,
              path: req.path,
              status: res.statusCode,
              duration: `${duration}ms`
            });
          }
        });
        next();
      });
    }

    this.app.use(globalLimiter);
  }

  private setupRoutes(): void {
    setupSwaggerUi(this.app);
    this.app.get('/metrics', metricsHandler);

    /**
     * @swagger
     * /health:
     *   get:
     *     tags: [Health]
     *     summary: Liveness probe
     *     description: Returns service health including MQTT and storage stats when health checks are enabled.
     *     responses:
     *       200:
     *         description: Service is healthy
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/HealthResponse'
     */
    this.app.get('/health', async (req: Request, res: Response) => {
      if (this.config.healthChecksEnabled === false) {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
        return;
      }

      const internalSecret = process.env.INTERNAL_HEALTH_SECRET;
      const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0]?.trim();
      const ip = req.ip || req.socket.remoteAddress || '';
      const isLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip) || forwardedFor === '127.0.0.1';
      const isInternal =
        isLoopback ||
        (Boolean(internalSecret) && req.headers['x-internal-health'] === internalSecret);

      if (!isInternal) {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
        return;
      }

      const allDevices = await this.deviceService.getAllDevices();
      const activeDevices = Array.from(allDevices.values()).filter(d => d.status === 'active');
      const inactiveDevices = allDevices.size - activeDevices.length;

      const redisSvc = getRedisService();
      const health: Record<string, unknown> = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        mqtt: {
          connected: this.mqttClient.isConnected(),
          pendingAcks: this.mqttClient.getPendingAckCount()
        },
        storage: {
          sessions: await this.sessionService.getAllSessions().then(s => s.size),
          devices: {
            total: allDevices.size,
            active: activeDevices.length,
            inactive: inactiveDevices
          }
        }
      };

      if (redisSvc) {
        health.redis = {
          connected: redisSvc.isRedisConnected(),
          since: redisSvc.getStatsSince(),
          commands: redisSvc.getCommandStats()
        };
      }

      res.json(health);
    });

    /**
     * @swagger
     * /ready:
     *   get:
     *     tags: [Health]
     *     summary: Deep readiness probe
     *     description: Returns 503 when dependencies (Redis, poller, etc.) are not ready.
     *     responses:
     *       200:
     *         description: Ready
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/ReadinessResponse'
     *       503:
     *         description: Not ready
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/ReadinessResponse'
     */
    this.app.get('/ready', async (_req: Request, res: Response) => {
      try {
        const payload = this.readinessProvider
          ? await this.readinessProvider()
          : { ready: true, note: 'no_readiness_provider' };
        const ready = payload && typeof payload === 'object' && (payload as { ready?: boolean }).ready === true;
        res.status(ready ? 200 : 503).json(payload);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(503).json({ ready: false, error: msg });
      }
    });

    /**
     * @swagger
     * /api:
     *   get:
     *     tags: [Health]
     *     summary: API index
     *     description: Lightweight JSON discovery of key endpoints. Full interactive docs at /api/docs.
     *     responses:
     *       200:
     *         description: API metadata and endpoint map
     */
    this.app.get('/api', (req: Request, res: Response) => {
      res.json({
        name: 'mqtt-publisher-lite',
        version: '1.0.0',
        description: 'Lightweight MQTT Publisher for firmware testing',
        docs: '/api/docs',
        endpoints: {
          health: '/health',
          ready: '/ready',
          docs: '/api/docs',
          provisioning: {
            onboarding: 'POST /api/v1/onboarding',
            signCSR: 'POST /api/v1/sign-csr',
            downloadCert: 'GET /api/v1/certificates/:id/download',
            certStatus: 'GET /api/v1/certificates/:deviceId/status',
            revokeCert: 'DELETE /api/v1/certificates/:deviceId',
            recoveryGenerateSession: 'POST /api/v1/recovery/generate-session',
            reissueWithRecovery:
              'POST /api/v1/certificates/reissue (body: device_id, csr, recovery_token — requires prior generate-session)'
          },
          webhooks: {
            gmb: 'POST /api/webhooks/google-business-reviews'
          },
          note: 'User management is handled by Next.js web app'
        }
      });
    });

    // Error handler
    this.app.use((error: any, req: Request, res: Response, _next: NextFunction) => {
      logger.error('Unhandled error', {
        error: error.message,
        path: req.path
      });
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer(this.app);
      this.server.listen(this.config.port, this.config.host, () => {
        logger.info('HTTP server started', {
          host: this.config.host,
          port: this.config.port
        });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('HTTP server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  getServer(): Server {
    if (!this.server) {
      throw new Error('Server not started');
    }
    return this.server;
  }

  getApp(): Express {
    return this.app;
  }
}
