import { logger } from './utils/logger';
import { loadConfig, validateConfig, AppConfig } from './config';
import { HttpServer } from './servers/httpServer';
import { WebSocketServerManager } from './servers/webSocketServer';
import { MqttClientManager } from './servers/mqttClient';
import { StatsPublisher } from './services/statsPublisher';
import { ProvisioningService } from './services/provisioningService';
import { CAService } from './services/caService';
import { AuthService } from './services/authService';
import { UserService } from './services/userService';
import { MongoService, createMongoService } from './services/mongoService';
import { RedisService, createRedisService } from './services/redisService';
import { DeviceService } from './services/deviceService';
import { SessionService } from './services/sessionService';
import { createProvisioningRoutes } from './routes/provisioningRoutes';
import { getTokenStore } from './storage/tokenStore';

export class StatsMqttLite {
  private config: AppConfig;
  private httpServer!: HttpServer;
  private webSocketServer!: WebSocketServerManager;
  private mqttClient!: MqttClientManager;
  
  // MongoDB-based services
  private sessionService!: SessionService;
  private deviceService!: DeviceService;
  // Note: User management handled by Next.js web app (shared database)
  
  // Stats publisher
  private statsPublisher!: StatsPublisher;
  
  // Provisioning services
  private provisioningService?: ProvisioningService;
  private caService?: CAService;
  private authService?: AuthService;
  private userService?: UserService;
  
  // MongoDB service
  private mongoService?: MongoService;
  
  // Redis service
  private redisService?: RedisService;
  
  // Startup time for grace period
  private startupTime: number = Date.now();
  private keepAliveTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.config = loadConfig();
    validateConfig(this.config);
  }

  async start(): Promise<void> {
    try {
      logger.info('🚀 Starting MQTT Publisher Lite...');
      logger.info('━'.repeat(50));

      // Initialize MongoDB (REQUIRED)
      await this.initializeMongoDB();

      // Initialize Redis (for token persistence)
      if (this.config.redis.enabled) {
        await this.initializeRedis();
      }

      // Initialize services
      await this.initializeServices();

      // Initialize provisioning services (if enabled)
      await this.initializeProvisioning();

      // Initialize MQTT client
      await this.initializeMqttClient();

      // Initialize HTTP server (includes provisioning routes)
      await this.initializeHttpServer();

      // Initialize WebSocket server
      await this.initializeWebSocketServer();

      // Initialize stats publisher
      await this.initializeStatsPublisher();

      // Initialize keep-alive for Render.com free tier
      this.initializeKeepAlive();

      logger.info('━'.repeat(50));
      logger.info('✅ MQTT Publisher Lite started successfully');
      logger.info('');
      logger.info('📡 MQTT Broker:', `${this.config.mqtt.broker}:${this.config.mqtt.port}`);
      logger.info('🌐 HTTP API:', `http://${this.config.http.host}:${this.config.http.port}`);
      logger.info('🔌 WebSocket:', `ws://${this.config.http.host}:${this.config.http.port}/ws`);
      logger.info('📂 Data Directory:', this.config.storage.dataDir);
      logger.info('🗃️  MongoDB:', `Connected (${this.config.mongodb.dbName})`);
      if (this.config.redis.enabled && this.redisService) {
        logger.info('💾 Redis:', `Connected (Token Persistence)`);
      }
      if (this.config.provisioning.enabled) {
        const tokenStorage = this.redisService ? 'Redis' : 'In-Memory';
        logger.info('🔐 Provisioning API:', `http://${this.config.http.host}:${this.config.http.port}/api/v1/onboarding (${tokenStorage})`);
      }
      logger.info('');
      logger.info('Ready for firmware testing! 🎯');
      logger.info('━'.repeat(50));

    } catch (error: any) {
      logger.error('Failed to start application', { 
        error: error.message,
        stack: error.stack 
      });
      throw error;
    }
  }

  private async initializeServices(): Promise<void> {
    logger.info('📦 Initializing services...');

    // Session Service (in-memory)
    this.sessionService = new SessionService(this.config.storage.sessionTTL);
    await this.sessionService.initialize();

    // Device Service (MongoDB)
    this.deviceService = new DeviceService(this.config.storage.deviceCleanupInterval);
    await this.deviceService.initialize();

    // User Service removed - handled by Next.js web app (shared database)
    
    logger.info('✅ Services initialized');
  }

  private async initializeMongoDB(): Promise<void> {
    logger.info('🗃️  Initializing MongoDB (REQUIRED)...');

    if (!this.config.mongodb.uri) {
      throw new Error('MongoDB URI is required. Set MONGODB_URI environment variable.');
    }

    try {
      this.mongoService = createMongoService({
        uri: this.config.mongodb.uri,
        dbName: this.config.mongodb.dbName
      });

      await this.mongoService.connect();

      logger.info('✅ MongoDB connected successfully', {
        dbName: this.config.mongodb.dbName,
        mode: 'primary-database'
      });
    } catch (error: any) {
      logger.error('❌ Failed to connect to MongoDB', {
        error: error.message,
        stack: error.stack
      });
      logger.error('💡 MongoDB is REQUIRED for mqtt-publisher-lite');
      logger.error('   Set MONGODB_URI environment variable');
      throw error;
    }
  }

  private async initializeRedis(): Promise<void> {
    logger.info('💾 Initializing Redis (Token Persistence)...');

    try {
      this.redisService = createRedisService({
        url: this.config.redis.url,
        username: this.config.redis.username,
        password: this.config.redis.password,
        host: this.config.redis.host,
        port: this.config.redis.port,
        db: this.config.redis.db,
        keyPrefix: this.config.redis.keyPrefix
      });

      await this.redisService.connect();

      logger.info('✅ Redis connected successfully', {
        keyPrefix: this.config.redis.keyPrefix,
        mode: 'cloud-persistent'
      });
    } catch (error: any) {
      logger.error('❌ Failed to connect to Redis', {
        error: error.message,
        stack: error.stack
      });
      logger.warn('⚠️  Provisioning tokens will not be persistent');
      logger.warn('   Set REDIS_URL (cloud) or REDIS_HOST (self-hosted)');
      // Don't throw - provisioning can work without Redis (in-memory fallback)
    }
  }

  private async initializeProvisioning(): Promise<void> {
    if (!this.config.provisioning.enabled) {
      logger.info('🔐 Provisioning disabled (set PROVISIONING_ENABLED=true to enable)');
      return;
    }

    logger.info('🔐 Initializing provisioning services...');

    try {
      // Initialize AuthService
      if (!this.config.auth?.secret) {
        throw new Error('AUTH_SECRET is required for provisioning');
      }
      this.authService = new AuthService(this.config.auth.secret);
      logger.info('✅ AuthService initialized');

      // Initialize UserService
      if (!this.mongoService) {
        throw new Error('MongoDB service required for UserService');
      }
      this.userService = new UserService(this.mongoService);
      await this.userService.initialize();
      logger.info('✅ UserService initialized');

      // Initialize Provisioning Service
      this.provisioningService = new ProvisioningService({
        tokenTTL: this.config.provisioning.tokenTTL,
        jwtSecret: this.config.provisioning.jwtSecret
      });

      // Initialize CA Service with MongoDB (always)
      this.caService = new CAService(
        {
          storagePath: this.config.provisioning.caStoragePath,
          rootCAValidityYears: this.config.provisioning.rootCAValidityYears,
          deviceCertValidityDays: this.config.provisioning.deviceCertValidityDays
        }
      );

      // Initialize Root CA
      await this.caService.initialize();
    
      logger.info('✅ Provisioning services initialized', {
        tokenTTL: this.config.provisioning.tokenTTL,
        caStoragePath: this.config.provisioning.caStoragePath,
        deviceCertValidityDays: this.config.provisioning.deviceCertValidityDays,
        storageMode: 'MongoDB'
      });
    } catch (error: any) {
      logger.error('Failed to initialize provisioning services', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  private async initializeMqttClient(): Promise<void> {
    logger.info('📡 Initializing MQTT client...');
    
    this.mqttClient = new MqttClientManager(this.config.mqtt);
    
    // Set up QoS 1 tracking callbacks for device liveness
    this.mqttClient.setDeviceCallbacks(
      // On device inactive (PUBACK timeout)
      async (deviceId: string) => {
        logger.warn('⚠️ Device marked INACTIVE due to QoS timeout', { deviceId });
        await this.deviceService.updateDeviceStatus(deviceId, 'inactive');
      },
      // On device active (PUBACK received)
      // ✅ FIX: Don't automatically set device to active on PUBACK
      // This was interfering with explicit unregistration
      async (deviceId: string) => {
        // Only mark device as active if it's not explicitly inactive
        const device = await this.deviceService.getDevice(deviceId);
        if (device && device.status !== 'inactive') {
          await this.deviceService.updateDeviceStatus(deviceId, 'active');
        }
      }
    );
    
    await this.mqttClient.connect();
    
    // Subscribe to test topics for firmware testing
    await this.subscribeToTopics();
    
    logger.info('✅ MQTT client initialized with QoS 1 tracking');
  }

  private async subscribeToTopics(): Promise<void> {
    // Subscribe to statsnapp topics (matching original mqtt-publisher)
    const topics = [
      'statsnapp/+/active',      // Device registration messages
      'statsnapp/+/lwt',         // Last Will and Testament (broker-generated disconnect)
      'statsnapp/+/status',      // Device status messages
      'statsnapp/+/update',      // Live metrics updates
      'statsnapp/+/milestone',   // Milestone notifications
      'statsnapp/+/alert',       // Alert messages
      'statsnapp/+/metrics',     // Device metrics
      'statsnapp/+/events',      // Device events
      'statsnapp/system/+',      // System messages
      'statsnapp/alerts/+',      // Alert messages
      'statsnapp/commands/+'     // Command messages
    ];

    for (const topic of topics) {
      await this.mqttClient.subscribe(topic, async (receivedTopic, payload, packet) => {
        try {
          // ✅ FILTER 1: Skip retained messages (old broker cache)
          if (packet?.retain) {
            logger.debug('Ignoring retained message', { 
              topic: receivedTopic,
              reason: 'retained flag set'
            });
            return;
          }

          // ✅ FILTER 2: Startup grace period (first 3 seconds)
          // Ignore all messages during first 3 seconds to skip broker buffered messages
          const uptime = Date.now() - this.startupTime;
          if (uptime < 3000) {
            logger.debug('Ignoring message during startup grace period', {
              topic: receivedTopic,
              uptime: `${Math.floor(uptime / 1000)}s`,
              gracePeriod: '3s'
            });
            return;
          }

          const message = JSON.parse(payload.toString());

          // ✅ FILTER 3: Timestamp validation (ignore messages older than 2 minutes)
          if (message.timestamp) {
            const messageAge = Date.now() - new Date(message.timestamp).getTime();
            if (messageAge > 120000) {  // 2 minutes
              logger.debug('Ignoring old message', {
                topic: receivedTopic,
                age: `${Math.floor(messageAge / 1000)}s`,
                threshold: '120s'
              });
              return;
            }
          }
          
          // ✅ NOW SAFE TO PROCESS - Only fresh, real-time messages
          
          // Log based on topic type
          if (receivedTopic.endsWith('/active')) {
            await this.handleDeviceRegistration(receivedTopic, message);
          } else if (receivedTopic.endsWith('/lwt')) {
            await this.handleDeviceLWT(receivedTopic, message);
          } else if (receivedTopic.endsWith('/status')) {
            await this.handleDeviceStatus(receivedTopic, message);
          } else if (receivedTopic.endsWith('/update')) {
            await this.handleLiveUpdate(receivedTopic, message);
          } else if (receivedTopic.endsWith('/milestone')) {
            await this.handleMilestone(receivedTopic, message);
          } else if (receivedTopic.endsWith('/alert')) {
            await this.handleAlert(receivedTopic, message);
          } else {
            logger.debug('MQTT message received', {
              topic: receivedTopic,
              type: message.type || 'unknown',
              size: payload.length
            });
          }
          
          // Update device last seen (but skip for unregistration messages)
          // ✅ FIX: Don't update lastSeen for unregistration to preserve inactive status
          const deviceId = this.extractDeviceId(receivedTopic);
          if (deviceId && message.type !== 'un_registration') {
            await this.deviceService.updateLastSeen(deviceId).catch(err => {
              logger.debug('Device not found in storage', { deviceId });
            });
          }
        } catch (error: any) {
          logger.error('Error processing MQTT message', {
            topic: receivedTopic,
            error: error.message
          });
        }
      });
    }

    logger.info('Subscribed to statsnapp topics', { count: topics.length });
  }

  private async handleDeviceRegistration(topic: string, message: any): Promise<void> {
    const deviceId = this.extractDeviceId(topic);
    if (!deviceId) return;

    // ✅ /active topic ONLY handles device registration (client connects)
    // ✅ /lwt topic handles ALL disconnections (both graceful and unexpected)
    //    - Broker publishes LWT automatically when client disconnects
    //    - Works for: Ctrl+C, power cut, crash, network failure, force close
    
    logger.info('📱 Device Registration Received', {
      deviceId,
      userId: message.userId || message.user_id,
      deviceType: message.deviceType || message.device_type,
      os: message.os,
      type: message.type
    });

    // Register device if not exists
    const existingDevice = await this.deviceService.getDevice(deviceId);
    if (!existingDevice) {
      await this.deviceService.registerDevice({
        deviceId,
        clientId: message.clientId || deviceId,
        macID: deviceId, // Use deviceId as macID
        username: message.userId || message.user_id || 'unknown',
        status: 'active',
        lastSeen: new Date(),
        metadata: {
          deviceType: message.deviceType || message.device_type,
          os: message.os,
          appVersion: message.appVersion || message.app_version,
          registeredAt: new Date().toISOString()
        }
      });
      logger.info('✅ New device registered', { deviceId });
      
      // Send registration confirmation for new device
      await this.sendRegistrationResponse(deviceId, true, 'Device registered successfully', true);
    } else {
      await this.deviceService.updateDeviceStatus(deviceId, 'active');
      logger.info('✅ Existing device reconnected', { deviceId });
      
      // Send registration confirmation for existing device
      await this.sendRegistrationResponse(deviceId, true, 'Device reconnected successfully', false);
    }
  }

  /**
   * Handle Last Will and Testament (LWT) messages
   * ✅ LWT is broker-generated for ALL client disconnections:
   *    - Graceful shutdown (Ctrl+C, app close)
   *    - Unexpected disconnect (power cut, crash, network failure)
   * 
   * How it works:
   *    1. Client configures LWT at connection time
   *    2. Broker stores LWT in memory
   *    3. When client disconnects (any reason), broker publishes LWT
   *    4. Server receives LWT and marks device as inactive
   * 
   * Payload is minimal: {"type":"un_registration","clientId":"client-XXX"}
   */
  private async handleDeviceLWT(topic: string, message: any): Promise<void> {
    const deviceId = this.extractDeviceId(topic);
    if (!deviceId) {
      logger.warn('⚠️ LWT message received but could not extract deviceId', { topic });
      return;
    }

    // Validate LWT message format (minimal payload expected)
    if (message.type !== 'un_registration') {
      logger.warn('⚠️ Invalid LWT message type', { 
        deviceId, 
        type: message.type,
        expected: 'un_registration'
      });
      return;
    }

    if (!message.clientId) {
      logger.warn('⚠️ LWT message missing clientId', { deviceId });
      return;
    }

    logger.info('💀 LWT: Device Disconnected (Broker-Generated)', {
      deviceId,
      clientId: message.clientId,
      topic: '/lwt',
      reason: 'Client disconnected (all types: graceful, crash, power cut, etc.)',
      source: 'broker',
      mechanism: 'Last Will and Testament'
    });
    
    // Mark device as inactive
    await this.deviceService.updateDeviceStatus(deviceId, 'inactive');
    logger.info('✅ Device marked as inactive due to disconnect (LWT)', { deviceId });
    
    // Note: No acknowledgment is sent for LWT since the device is already disconnected
  }

  private async handleDeviceStatus(topic: string, message: any): Promise<void> {
    const deviceId = this.extractDeviceId(topic);
    if (!deviceId) return;

    logger.info('📊 Device Status Update', {
      deviceId,
      status: message.status,
      uptime: message.uptime
    });
  }

  private async handleLiveUpdate(topic: string, message: any): Promise<void> {
    const deviceId = this.extractDeviceId(topic);
    logger.info('📈 Live Metrics Update', {
      deviceId,
      type: message.type || message.subtype,
      followers: message.payload?.stats?.followers,
      following: message.payload?.stats?.following
    });
  }

  private async handleMilestone(topic: string, message: any): Promise<void> {
    const deviceId = this.extractDeviceId(topic);
    logger.info('🎯 Milestone Achieved', {
      deviceId,
      milestone: message.payload?.milestone,
      value: message.payload?.current_value
    });
  }

  private async handleAlert(topic: string, message: any): Promise<void> {
    const deviceId = this.extractDeviceId(topic);
    logger.info('🚨 Alert Received', {
      deviceId,
      alert: message.payload?.alert_type,
      message: message.payload?.message
    });
  }

  private async sendRegistrationResponse(
    deviceId: string, 
    success: boolean, 
    message: string,
    isNewDevice: boolean = false
  ): Promise<void> {
    try {
      const response = {
        success,
        message,
        deviceId,
        isNewDevice,
        timestamp: new Date().toISOString(),
        serverVersion: '1.0.0'
      };

      await this.mqttClient.publish({
        topic: `statsnapp/${deviceId}/registration_ack`,
        payload: JSON.stringify(response),
        qos: 1,
        retain: false
      });

      logger.info('📤 Registration response sent', {
        deviceId,
        success,
        isNewDevice
      });
    } catch (error: any) {
      logger.error('Failed to send registration response', {
        deviceId,
        error: error.message
      });
    }
  }

  private async sendUnregistrationResponse(
    deviceId: string, 
    success: boolean, 
    message: string
  ): Promise<void> {
    try {
      const response = {
        success,
        message,
        deviceId,
        timestamp: new Date().toISOString(),
        serverVersion: '1.0.0',
        disconnectType: 'graceful'
      };

      await this.mqttClient.publish({
        topic: `statsnapp/${deviceId}/unregistration_ack`,
        payload: JSON.stringify(response),
        qos: 1,
        retain: false
      });

      logger.info('📤 Un-registration response sent', {
        deviceId,
        success
      });
    } catch (error: any) {
      logger.error('Failed to send un-registration response', {
        deviceId,
        error: error.message
      });
    }
  }

  private extractDeviceId(topic: string): string | null {
    // Extract from pattern: statsnapp/DEVICE_ID/suffix
    const match = topic.match(/^statsnapp\/([^\/]+)\//);
    return match ? match[1] : null;
  }

  private async initializeHttpServer(): Promise<void> {
    logger.info('🌐 Initializing HTTP server...');
    
    this.httpServer = new HttpServer(
      this.config.http,
      this.sessionService,
      this.deviceService,
      this.mqttClient
    );
    
    // Add provisioning routes if enabled
    if (this.config.provisioning.enabled && this.provisioningService && this.caService && this.authService && this.userService) {
      const provisioningRoutes = createProvisioningRoutes({
        provisioningService: this.provisioningService,
        caService: this.caService,
        authService: this.authService,
        userService: this.userService
      });
      this.httpServer.getApp().use('/api/v1', provisioningRoutes);
      logger.info('✅ Provisioning routes registered at /api/v1');
    }
    
    await this.httpServer.start();
    
    logger.info('✅ HTTP server initialized');
  }

  private async initializeWebSocketServer(): Promise<void> {
    logger.info('🔌 Initializing WebSocket server...');
    
    this.webSocketServer = new WebSocketServerManager(
      this.httpServer.getServer(),
      this.mqttClient
    );
    
    logger.info('✅ WebSocket server initialized');
  }

  private async initializeStatsPublisher(): Promise<void> {
    logger.info('📊 Initializing stats publisher...');
    
    this.statsPublisher = new StatsPublisher(
      this.mqttClient,
      this.deviceService,
      15000  // Publish every 15 seconds for testing
    );
    
    await this.statsPublisher.start();
    
    logger.info('✅ Stats publisher initialized - publishing every 15s');
  }

  private initializeKeepAlive(): void {
    // Keep-alive for Render.com free tier (prevents spin-down)
    // Pings self every 10 minutes to keep service awake (5-minute safety margin)
    const keepAliveInterval = 10 * 60 * 1000;  // 10 minutes
    
    this.keepAliveTimer = setInterval(() => {
      const url = `http://localhost:${this.config.http.port}/health`;
      
      // Use native fetch (Node 18+) or http module
      const http = require('http');
      http.get(url, (res: any) => {
        logger.debug('Keep-alive ping sent', { 
          status: res.statusCode,
          interval: '10min'
        });
      }).on('error', (err: any) => {
        logger.debug('Keep-alive ping failed (normal if external monitoring exists)', { 
          error: err.message 
        });
      });
    }, keepAliveInterval);
    
    logger.info('🔄 Keep-alive enabled for free tier', { 
      interval: '10 minutes',
      note: 'Prevents Render.com spin-down (5min safety margin)'
    });
  }

  async stop(): Promise<void> {
    logger.info('🛑 Stopping MQTT Publisher Lite...');
    
    try {
      // Stop keep-alive timer
      if (this.keepAliveTimer) {
        clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = null;
      }

      // Stop stats publisher
      if (this.statsPublisher) {
        await this.statsPublisher.stop();
      }

      // Close WebSocket server
      if (this.webSocketServer) {
        this.webSocketServer.close();
      }

      // Close HTTP server
      if (this.httpServer) {
        await this.httpServer.stop();
      }

      // Disconnect MQTT client
      if (this.mqttClient) {
        await this.mqttClient.disconnect();
      }

      // Close storage
      // Close services
      if (this.sessionService) {
        await this.sessionService.close();
      }
      if (this.deviceService) {
        await this.deviceService.close();
      }
      
      // Shutdown token store
      if (this.config.provisioning.enabled) {
        getTokenStore().shutdown();
      }
      
      // Certificate store is MongoDB (no closing needed)
      
      // Disconnect MongoDB
      if (this.mongoService) {
        await this.mongoService.disconnect();
      }
      
      // Disconnect Redis
      if (this.redisService) {
        await this.redisService.disconnect();
      }
      
      logger.info('✅ Application stopped gracefully');
    } catch (error: any) {
      logger.error('Error during shutdown', { error: error.message });
      throw error;
    }
  }
}
