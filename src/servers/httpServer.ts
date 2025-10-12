import express, { Express, Request, Response } from 'express';
import { createServer, Server } from 'http';
import { join } from 'path';
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
    this.app.use(helmet({
      contentSecurityPolicy: false  // Allow inline scripts for testing interface
    }));
    this.app.use(compression());
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Serve static files from public directory
    // ✅ FIX: Use process.cwd() for deployment compatibility
    const publicPath = join(process.cwd(), 'public');
    this.app.use(express.static(publicPath));
    logger.info('Serving static files from', { 
      path: publicPath,
      __dirname: __dirname,
      cwd: process.cwd()
    });

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
    this.app.get('/api', (req: Request, res: Response) => {
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
        }, {
          direction: 'server_to_client',
          source: 'http_api',
          timestamp: new Date().toISOString(),
          initiator: req.ip || 'unknown'
        });

        res.json({ success: true, topic, published: new Date().toISOString() });
      } catch (error: any) {
        logger.error('Failed to publish message', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    // ===== TESTING API ENDPOINTS =====
    
    // Simulate device registration
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
        
        await this.mqttClient.publish({
          topic,
          payload: JSON.stringify(registrationMessage),
          qos: 1,
          retain: false
        }, {
          direction: 'server_to_client',
          source: 'http_api',
          deviceId,
          timestamp: new Date().toISOString(),
          initiator: req.ip || 'unknown'
        });

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

    // Simulate device unregistration
    this.app.post('/api/test/unregister', async (req: Request, res: Response) => {
      try {
        const { deviceId, userId } = req.body;
        
        if (!deviceId || !userId) {
          return res.status(400).json({ error: 'deviceId and userId are required' });
        }

        // ✅ FIX: Process unregistration directly instead of relying on MQTT message routing
        // Since MQTT brokers typically don't deliver messages back to the same client,
        // we'll process the unregistration directly here
        
        logger.info('📱 Device Un-registration (Direct)', {
          deviceId,
          userId
        });
        
        // Update device status to inactive
        await this.deviceStorage.updateDeviceStatus(deviceId, 'inactive');
        logger.info('✅ Device marked as inactive (unregistered)', { deviceId });
        
        // Also publish the unregistration message for other subscribers (like real devices)
        const unregistrationMessage = {
          type: 'un_registration',
          userId,
          clientId: deviceId,
          timestamp: new Date().toISOString()
        };

        const topic = `statsnapp/${deviceId}/active`;
        
        await this.mqttClient.publish({
          topic,
          payload: JSON.stringify(unregistrationMessage),
          qos: 1,
          retain: false
        }, {
          direction: 'server_to_client',
          source: 'http_api',
          deviceId,
          timestamp: new Date().toISOString(),
          initiator: req.ip || 'unknown'
        });

        res.json({ 
          success: true, 
          message: 'Device unregistered successfully (processed directly)',
          topic,
          deviceId,
          timestamp: new Date().toISOString()
        });
      } catch (error: any) {
        logger.error('Failed to unregister test device', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    // Publish custom test message
    this.app.post('/api/test/publish-custom', async (req: Request, res: Response) => {
      try {
        const { deviceId, messageType, payload, qos = 1, retain = false } = req.body;
        
        if (!deviceId || !messageType || !payload) {
          return res.status(400).json({ 
            error: 'deviceId, messageType, and payload are required' 
          });
        }

        // Map message types to topics
        const topicMap: { [key: string]: string } = {
          registration: 'active',
          status: 'status',
          update: 'update',
          milestone: 'milestone',
          alert: 'alert',
          metrics: 'metrics',
          events: 'events'
        };

        const topicSuffix = topicMap[messageType] || messageType;
        const topic = `statsnapp/${deviceId}/${topicSuffix}`;
        
        await this.mqttClient.publish({
          topic,
          payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
          qos: qos as 0 | 1 | 2,
          retain
        }, {
          direction: 'server_to_client',
          source: 'http_api',
          deviceId,
          timestamp: new Date().toISOString(),
          initiator: req.ip || 'unknown'
        });

        res.json({ 
          success: true, 
          message: 'Custom message published',
          topic,
          deviceId,
          messageType,
          qos,
          retain,
          timestamp: new Date().toISOString()
        });
      } catch (error: any) {
        logger.error('Failed to publish custom test message', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    // DEBUG: Direct device status update (for testing)
    this.app.post('/api/test/set-device-status', async (req: Request, res: Response) => {
      try {
        const { deviceId, status } = req.body;
        
        if (!deviceId || !status) {
          return res.status(400).json({ error: 'deviceId and status are required' });
        }

        if (!['active', 'inactive'].includes(status)) {
          return res.status(400).json({ error: 'status must be active or inactive' });
        }

        await this.deviceStorage.updateDeviceStatus(deviceId, status);

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
