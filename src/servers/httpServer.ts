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

  constructor(
    config: HttpConfig,
    sessionService: SessionService,
    deviceService: DeviceService,
    mqttClient: MqttClientManager
  ) {
    this.config = config;
    this.sessionService = sessionService;
    this.deviceService = deviceService;
    this.mqttClient = mqttClient;
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
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

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
        logger.info('HTTP request', {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration: `${duration}ms`
        });
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

    // Root endpoint
    this.app.get('/api', (req: Request, res: Response) => {
      res.json({
        name: 'mqtt-publisher-lite',
        version: '1.0.0',
        description: 'Lightweight MQTT Publisher for firmware testing',
        endpoints: {
          health: '/health',
          sessions: '/api/sessions',
          devices: '/api/devices (supports ?status=active or ?status=inactive)',
          publish: '/api/publish',
          provisioning: {
            onboarding: 'POST /api/v1/onboarding',
            signCSR: 'POST /api/v1/sign-csr',
            downloadCert: 'GET /api/v1/certificates/:id/download',
            certStatus: 'GET /api/v1/certificates/:deviceId/status',
            revokeCert: 'DELETE /api/v1/certificates/:deviceId'
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

    // MQTT publish endpoint
    this.app.post('/api/publish', async (req: Request, res: Response) => {
      try {
        const { topic, payload, qos = 0, retain = false } = req.body;
        if (!topic || !payload) {
          return res.status(400).json({ error: 'topic and payload are required' });
        }

        await this.mqttClient.publish(
          {
            topic,
            payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
            qos: qos as 0 | 1 | 2,
            retain
          },
          {
            direction: 'server_to_client',
            source: 'http_api',
            timestamp: new Date().toISOString(),
            initiator: req.ip || 'unknown'
          }
        );

        res.json({ success: true, topic, published: new Date().toISOString() });
      } catch (error: any) {
        logger.error('Failed to publish message', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    // Testing endpoints
    this.app.post('/api/test/register', async (req: Request, res: Response) => {
      try {
        const { deviceId, userId, deviceType = 'mobile', os = 'iOS 17.0', appVersion = '1.0.0' } = req.body;

        if (!deviceId || !userId) {
          return res.status(400).json({ error: 'deviceId and userId are required' });
        }

        const registrationMessage = {
          type: 'device_registration',
          userId,
          clientId: deviceId,
          timestamp: new Date().toISOString(),
          deviceType,
          os,
          appVersion,
          metadata: {
            deviceType,
            os,
            appVersion,
            ipAddress: req.ip || '127.0.0.1',
            userAgent: req.headers['user-agent'] || 'Test-Client'
          }
        };

        const topic = `statsnapp/${deviceId}/active`;
        await this.mqttClient.publish(
          {
            topic,
            payload: JSON.stringify(registrationMessage),
            qos: 1,
            retain: false
          },
          {
            direction: 'server_to_client',
            source: 'http_api',
            deviceId,
            timestamp: new Date().toISOString(),
            initiator: req.ip || 'unknown'
          }
        );

        res.json({
          success: true,
          message: 'Device registration message published',
          topic,
          deviceId,
          timestamp: new Date().toISOString()
        });
      } catch (error: any) {
        logger.error('Failed to register test device', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/test/unregister', async (req: Request, res: Response) => {
      try {
        const { deviceId } = req.body;

        if (!deviceId) {
          return res.status(400).json({ error: 'deviceId is required' });
        }

        const clientId = `client-${deviceId.replace('STATSNAPP_US-', '')}`;

        logger.info('💀 Simulating LWT: Device Disconnect (Test)', {
          deviceId,
          clientId,
          note: 'This simulates what the broker would send automatically'
        });

        await this.deviceService.updateDeviceStatus(deviceId, 'inactive');
        logger.info('✅ Device marked as inactive (LWT simulation)', { deviceId });

        const lwtMessage = {
          type: 'un_registration',
          clientId: clientId
        };

        const topic = `statsnapp/${deviceId}/lwt`;
        await this.mqttClient.publish(
          {
            topic,
            payload: JSON.stringify(lwtMessage),
            qos: 1,
            retain: false
          },
          {
            direction: 'broker_to_server',
            source: 'broker',
            deviceId,
            timestamp: new Date().toISOString(),
            initiator: 'broker-lwt'
          }
        );

        res.json({
          success: true,
          message: 'Device disconnected (LWT simulation)',
          topic,
          deviceId,
          clientId,
          note: 'LWT payload is minimal (broker-generated)',
          timestamp: new Date().toISOString()
        });
      } catch (error: any) {
        logger.error('Failed to simulate LWT disconnect', { error: error.message });
        res.status(500).json({ error: error.message });
      }
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

