import express, { Express, Request, Response, NextFunction } from 'express';
import { createServer, Server } from 'http';
import { join } from 'path';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { logger } from '../utils/logger';
import { SessionService } from '../services/sessionService';
import { DeviceService } from '../services/deviceService';
import { MqttClientManager } from './mqttClient';

export interface HttpConfig {
  port: number;
  host: string;
}

export class HttpServer {
  private app: Express;
  private server: Server | null = null;
  private config: HttpConfig;
  private sessionService: SessionService;
  private deviceService: DeviceService;
  private mqttClient: MqttClientManager;
  private readinessProvider?: () => Promise<Record<string, unknown>>;

  constructor(
    config: HttpConfig,
    sessionService: SessionService,
    deviceService: DeviceService,
    mqttClient: MqttClientManager,
    readinessProvider?: () => Promise<Record<string, unknown>>
  ) {
    this.config = config;
    this.sessionService = sessionService;
    this.deviceService = deviceService;
    this.mqttClient = mqttClient;
    this.readinessProvider = readinessProvider;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(cors());
    this.app.use(helmet({
      contentSecurityPolicy: false
    }));
    this.app.use(compression());
    // Increase limit for sign-csr body (PEM CSR + token can be ~4–8kb)
    this.app.use(express.json({ limit: '512kb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '512kb' }));

    const publicPath = join(process.cwd(), 'public');
    this.app.use(express.static(publicPath));
    logger.info('Serving static files from', {
      path: publicPath,
      __dirname: __dirname,
      cwd: process.cwd()
    });

    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        
        // Health checks are logged at debug level to reduce log spam
        // (Render.com and other platforms ping /health every 5-10 seconds)
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

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', async (req: Request, res: Response) => {
      const allDevices = await this.deviceService.getAllDevices();
      const activeDevices = Array.from(allDevices.values()).filter(d => d.status === 'active');
      const inactiveDevices = allDevices.size - activeDevices.length;

      const health = {
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

      res.json(health);
    });

    /** Deep readiness for Instagram polling pipeline (serverless URL + Redis Lua + poller). Returns 503 when not ready. */
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

    // Root endpoint
    this.app.get('/api', (req: Request, res: Response) => {
      res.json({
        name: 'mqtt-publisher-lite',
        version: '1.0.0',
        description: 'Lightweight MQTT Publisher for firmware testing',
        endpoints: {
          health: '/health',
          ready: '/ready',
          sessions: '/api/sessions',
          devices: '/api/devices (supports ?status=active or ?status=inactive)',
          provisioning: {
            onboarding: 'POST /api/v1/onboarding',
            signCSR: 'POST /api/v1/sign-csr',
            downloadCert: 'GET /api/v1/certificates/:id/download',
            certStatus: 'GET /api/v1/certificates/:deviceId/status',
            revokeCert: 'DELETE /api/v1/certificates/:deviceId',
            recoveryGenerateCode: 'POST /api/v1/recovery/generate-code',
            reissueWithRecovery:
              'POST /api/v1/certificates/reissue (body: device_id, csr, recovery_code — requires prior generate-code)'
          },
          note: 'User management is handled by Next.js web app'
        }
      });
    });

    // Session endpoints
    this.app.post('/api/sessions', async (req: Request, res: Response) => {
      try {
        const sessionData = req.body;
        const sessionId = await this.sessionService.createSession(sessionData);
        res.status(201).json({ sessionId, success: true });
      } catch (error: any) {
        logger.error('Failed to create session', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/sessions/:sessionId', async (req: Request, res: Response) => {
      try {
        const session = await this.sessionService.getSession(req.params.sessionId);
        if (session) {
          res.json(session);
        } else {
          res.status(404).json({ error: 'Session not found' });
        }
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.delete('/api/sessions/:sessionId', async (req: Request, res: Response) => {
      try {
        await this.sessionService.deleteSession(req.params.sessionId);
        res.json({ success: true });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // Device endpoints
    this.app.post('/api/devices', async (req: Request, res: Response) => {
      try {
        const device = {
          ...req.body,
          status: 'active' as const,
          lastSeen: new Date().toISOString()
        };
        await this.deviceService.registerDevice(device);
        res.status(201).json({ success: true, deviceId: device.deviceId });
      } catch (error: any) {
        logger.error('Failed to register device', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/devices', async (req: Request, res: Response) => {
      try {
        const devices = await this.deviceService.getAllDevices();
        const devicesArray = Array.from(devices.values());
        const status = req.query.status as string;
        
        if (status) {
          const filtered = devicesArray.filter(d => d.status === status);
          return res.json(filtered);
        }
        res.json(devicesArray);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/devices/:deviceId', async (req: Request, res: Response) => {
      try {
        const device = await this.deviceService.getDevice(req.params.deviceId);
        if (device) {
          res.json(device);
        } else {
          res.status(404).json({ error: 'Device not found' });
        }
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // MQTT publish endpoints removed: publishing is handled only via broker mTLS connections.
    this.app.post('/api/publish', async (req: Request, res: Response) => {
      res.status(410).json({
        error: 'Endpoint removed',
        reason: 'HTTP-to-MQTT publish is disabled. Publish only via broker mTLS.',
        timestamp: new Date().toISOString()
      });
    });

    this.app.post('/api/test/register', async (_req: Request, res: Response) => {
      res.status(410).json({
        error: 'Endpoint removed',
        reason: 'HTTP-based device registration simulation is disabled. Use broker mTLS + device publish to /active.',
        timestamp: new Date().toISOString()
      });
    });

    this.app.post('/api/test/unregister', async (_req: Request, res: Response) => {
      res.status(410).json({
        error: 'Endpoint removed',
        reason: 'HTTP-based LWT simulation is disabled. Broker publishes LWT on disconnect.',
        timestamp: new Date().toISOString()
      });
    });

    this.app.post('/api/test/set-device-status', async (req: Request, res: Response) => {
      try {
        const { deviceId, status } = req.body;

        if (!deviceId || !status) {
          return res.status(400).json({ error: 'deviceId and status are required' });
        }

        if (!['active', 'inactive'].includes(status)) {
          return res.status(400).json({ error: 'status must be active or inactive' });
        }

        await this.deviceService.updateDeviceStatus(deviceId, status);

        res.json({
          success: true,
          message: `Device ${deviceId} status set to ${status}`,
          deviceId,
          status,
          timestamp: new Date().toISOString()
        });
      } catch (error: any) {
        logger.error('Failed to update device status', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    // Error handler
    this.app.use((error: any, req: Request, res: Response, next: NextFunction) => {
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

