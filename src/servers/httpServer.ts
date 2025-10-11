import express, { Express, Request, Response } from 'express';
import { createServer, Server } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { logger } from '../utils/logger';
import { AppConfig } from '../config';
import { SessionStorage } from '../storage/sessionStorage';
import { DeviceStorage } from '../storage/deviceStorage';
import { UserStorage } from '../storage/userStorage';
import { MqttClientManager } from './mqttClient';

export class HttpServer {
  private app: Express;
  private server: Server | null = null;
  private config: AppConfig['http'];
  private sessionStorage: SessionStorage;
  private deviceStorage: DeviceStorage;
  private userStorage: UserStorage;
  private mqttClient: MqttClientManager;

  constructor(
    config: AppConfig['http'],
    sessionStorage: SessionStorage,
    deviceStorage: DeviceStorage,
    userStorage: UserStorage,
    mqttClient: MqttClientManager
  ) {
    this.config = config;
    this.sessionStorage = sessionStorage;
    this.deviceStorage = deviceStorage;
    this.userStorage = userStorage;
    this.mqttClient = mqttClient;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(cors());
    this.app.use(helmet());
    this.app.use(compression());
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Request logging
    this.app.use((req, res, next) => {
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
      const allDevices = await this.deviceStorage.getAllDevices();
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
          sessions: await this.sessionStorage.getAllSessions().then(s => s.size),
          devices: {
            total: allDevices.size,
            active: activeDevices.length,
            inactive: inactiveDevices
          },
          users: await this.userStorage.getAllUsers().then(u => u.size)
        }
      };
      res.json(health);
    });

    // Root endpoint
    this.app.get('/', (req: Request, res: Response) => {
      res.json({
        name: 'mqtt-publisher-lite',
        version: '1.0.0',
        description: 'Lightweight MQTT Publisher for firmware testing',
        endpoints: {
          health: '/health',
          sessions: '/api/sessions',
          devices: '/api/devices (supports ?status=active or ?status=inactive)',
          users: '/api/users',
          publish: '/api/publish'
        }
      });
    });

    // Session endpoints
    this.app.post('/api/sessions', async (req: Request, res: Response) => {
      try {
        const sessionData = req.body;
        const sessionId = await this.sessionStorage.createSession(sessionData);
        res.status(201).json({ sessionId, success: true });
      } catch (error: any) {
        logger.error('Failed to create session', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/sessions/:sessionId', async (req: Request, res: Response) => {
      try {
        const session = await this.sessionStorage.getSession(req.params.sessionId);
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
        await this.sessionStorage.deleteSession(req.params.sessionId);
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
          status: 'active',
          lastSeen: new Date().toISOString()
        };
        await this.deviceStorage.registerDevice(device);
        res.status(201).json({ success: true, deviceId: device.deviceId });
      } catch (error: any) {
        logger.error('Failed to register device', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/devices', async (req: Request, res: Response) => {
      try {
        const devices = await this.deviceStorage.getAllDevices();
        const devicesArray = Array.from(devices.values());
        
        // Filter by status if provided (?status=active or ?status=inactive)
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
        const device = await this.deviceStorage.getDevice(req.params.deviceId);
        if (device) {
          res.json(device);
        } else {
          res.status(404).json({ error: 'Device not found' });
        }
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // User endpoints
    this.app.post('/api/users', async (req: Request, res: Response) => {
      try {
        const user = {
          ...req.body,
          devices: req.body.devices || [],
          createdAt: new Date().toISOString()
        };
        await this.userStorage.createUser(user);
        res.status(201).json({ success: true, userId: user.userId });
      } catch (error: any) {
        logger.error('Failed to create user', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/users', async (req: Request, res: Response) => {
      try {
        const users = await this.userStorage.getAllUsers();
        res.json(Array.from(users.values()));
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

        await this.mqttClient.publish({
          topic,
          payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
          qos: qos as 0 | 1 | 2,
          retain
        });

        res.json({ success: true, topic, published: new Date().toISOString() });
      } catch (error: any) {
        logger.error('Failed to publish message', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    // Error handler
    this.app.use((error: any, req: Request, res: Response, next: any) => {
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
