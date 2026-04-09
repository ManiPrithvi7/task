import { logger } from './utils/logger';
import {
  loadConfig,
  validateConfig,
  AppConfig,
  getMqttTlsRuntimeDir,
  reloadMqttTlsClientPemFromRuntime
} from './config';
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
import { DeviceService, getActiveDeviceCache, ActiveDeviceCache } from './services/deviceService';
import { SessionService } from './services/sessionService';
import { Device } from './models/Device';
import { User } from './models/User';
import { createProvisioningRoutes } from './routes/provisioningRoutes';
import { createConfigRoutes } from './routes/configRoutes';
import { getTokenStore } from './storage/tokenStore';
import * as dns from 'dns';
import * as tls from 'tls';
import * as fs from 'fs';
import * as path from 'path';
import * as forge from 'node-forge';
import mongoose from 'mongoose';
import { caForBrokerTls } from './utils/tlsBrokerCa';

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
  
  // Active device cache (Redis-backed)
  private activeDeviceCache!: ActiveDeviceCache;
  
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

      // Initialize Redis (REDIS_HOST + REDIS_PORT + REDIS_PASSWORD) for token persistence
      if (this.config.redis.enabled && this.config.redis.host && this.config.redis.port !== undefined) {
        await this.initializeRedis();
      } else if (this.config.redis.enabled) {
        logger.warn('⚠️  Redis enabled but REDIS_HOST or REDIS_PORT not set. Provisioning tokens will use in-memory storage.');
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

    // Active Device Cache (Redis-backed)
    this.activeDeviceCache = getActiveDeviceCache();
    await this.activeDeviceCache.flushAll(); // Clear stale keys from previous session
    logger.info('✅ Active device cache initialized (Redis)');
    
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
      logger.error(
        '   The MQTT broker is not contacted until MongoDB connects. ' +
          'If you see "Server selection timed out", check MongoDB Atlas Network Access (IP allowlist), VPN/firewall, and optionally MONGODB_SERVER_SELECTION_TIMEOUT_MS (default 5000).'
      );
      throw error;
    }
  }

  /** Returns the Redis connection host for production localhost check. */
  private getRedisConnectionHost(): string | null {
    return this.config.redis.host ?? null;
  }

  private async initializeRedis(): Promise<void> {
    logger.info('💾 Initializing Redis (Token Persistence)...');

    const redisHost = this.getRedisConnectionHost();
    const isLocalhost = redisHost === 'localhost' || redisHost === '127.0.0.1' || redisHost === '::1';
    if (this.config.app.env === 'production' && isLocalhost) {
      throw new Error(
        'Redis is configured to use localhost. On Render and other cloud platforms there is no Redis on localhost. ' +
        'Set REDIS_HOST and REDIS_PORT to your external Redis (e.g. Redis Cloud). To run without Redis, set REDIS_ENABLED=false.'
      );
    }

    this.redisService = createRedisService({
      host: this.config.redis.host,
      port: this.config.redis.port,
      password: this.config.redis.password,
      db: this.config.redis.db,
      keyPrefix: this.config.redis.keyPrefix,
      tls: this.config.redis.tls
    });

    // Check if Redis is configured before attempting connection
    if (!this.redisService.isRedisConfigured()) {
      logger.warn('⚠️  Redis enabled but no connection details provided. Provisioning tokens will use in-memory storage.');
      logger.warn('   Set REDIS_HOST and REDIS_PORT (and REDIS_PASSWORD if required).');
      logger.warn('   To disable Redis, set REDIS_ENABLED=false');
      this.config.redis.enabled = false; // Explicitly disable Redis in config if not configured
      return;
    }

    try {
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
      if (this.redisService) {
        try {
          await this.redisService.disconnect();
        } catch (disconnectError) {
          logger.debug('Redis disconnect error ignored', {
            error: disconnectError instanceof Error ? disconnectError.message : 'Unknown error'
          });
        }
        this.redisService = undefined;
      }
      this.config.redis.enabled = false;
      throw new Error(
        `Redis connection failed (${error?.message ?? 'unknown'}). ` +
        'Set REDIS_HOST, REDIS_PORT (and REDIS_PASSWORD if required). Fix the connection or set REDIS_ENABLED=false to use in-memory tokens (not persistent).'
      );
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

      // Log effective CN prefix and certificate profile for auditing/ops
      logger.info('Certificate profile in effect', {
        cnPrefix: this.config.provisioning.cnPrefix,
        certProfile: this.config.provisioning.certProfile
      });

      // Optionally generate a server/client certificate for this service (used for mTLS by the app itself)
      // Controlled via CREATE_MQTT_CLIENT_CERT=true and device id via MQTT_CLIENT_CERT_DEVICE_ID
      try {
        await this.ensureServerClientCertificate();
      } catch (err: any) {
        logger.warn('Server client certificate generation skipped or failed', { error: err instanceof Error ? err.message : String(err) });
      }
    
      logger.info('✅ Provisioning services initialized', {
        tokenTTL: this.config.provisioning.tokenTTL,
        caStoragePath: this.config.provisioning.caStoragePath,
        deviceCertValidityDays: this.config.provisioning.deviceCertValidityDays,
        storageMode: 'MongoDB',
        requireMtlsForRegistration: this.config.provisioning.requireMtlsForRegistration
      });
    } catch (error: any) {
      logger.error('Failed to initialize provisioning services', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Verify broker DNS resolution and (if TLS configured) perform a TLS handshake
   * to validate server certificate and CA. Throws on failure.
   */
  private async verifyBrokerConnectivity(): Promise<void> {
    const broker = this.config.mqtt.broker;
    const port = this.config.mqtt.port;

    // DNS lookup
    try {
      const lookup = await dns.promises.lookup(broker);
      logger.info('Broker DNS resolved', { broker, address: lookup.address });
    } catch (err: any) {
      logger.error('Broker DNS lookup failed', { broker, error: err.message });
      throw new Error(`DNS resolution failed for broker: ${broker}`);
    }

    const tlsCfg = this.config.mqtt.tls;
    if (!tlsCfg?.enabled) {
      logger.debug('MQTT TLS not enabled; skipping TLS handshake validation');
      return;
    }

    const caPem = tlsCfg.caPem?.includes('-----BEGIN') ? tlsCfg.caPem : undefined;

    if (!caPem?.includes('-----BEGIN')) {
      logger.warn('MQTT TLS enabled but no usable CA PEM; skipping TLS pre-check');
      return;
    }

    const clientCert =
      tlsCfg.clientCertPem?.includes('-----BEGIN') ? tlsCfg.clientCertPem : undefined;
    const clientKey =
      tlsCfg.clientKeyPem?.includes('-----BEGIN') ? tlsCfg.clientKeyPem : undefined;

    const x509Only = this.config.mqtt.authX509Only === true;
    if (x509Only && (!clientCert || !clientKey)) {
      throw new Error(
        'mTLS-only MQTT: provide client cert and key via MQTT_TLS_CLIENT_*_PEM or MQTT_TLS_CLIENT_*_BASE64 for broker pre-check'
      );
    }

    try {
      const tlsServerName = tlsCfg.servername || broker;
      if (!tlsCfg.servername && /\.proxy\.rlwy\.net$/i.test(broker)) {
        logger.warn(
          'MQTT_BROKER looks like a Railway TCP proxy host; TLS hostname check uses SNI. If the broker certificate CN/SAN is different (e.g. nanomq-broker), set MQTT_TLS_SERVERNAME to that name.',
          { broker, tlsServerNameUsed: tlsServerName }
        );
      }
      logger.info('MQTT TLS pre-check', { broker, port, servername: tlsServerName });
      await new Promise<void>((resolve, reject) => {
        const socket = tls.connect(
          {
            host: broker,
            port,
            ca: caForBrokerTls(caPem),
            cert: clientCert,
            key: clientKey,
            servername: tlsServerName,
            rejectUnauthorized: tlsCfg.rejectUnauthorized !== false,
            timeout: 5000
          },
          () => {
            if (!socket.authorized) {
              const errMsg = socket.authorizationError || 'TLS authorization failed';
              socket.end();
              reject(errMsg);
              return;
            }
            const peer = socket.getPeerCertificate(true) as any;
            logger.info('TLS handshake succeeded', { broker, subject: peer?.subject || null });
            socket.end();
            resolve();
          }
        );

        socket.on('error', (e) => {
          const msg = e instanceof Error ? e.message : String(e);
          reject(msg);
        });

        setTimeout(() => {
          socket.destroy();
          reject('TLS handshake timeout');
        }, 5000);
      });
    } catch (err: any) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('TLS handshake/check failed', { broker, error: errMsg });
      const nameMismatch =
        /altnames|Hostname\/IP does not match|does not match certificate/i.test(errMsg);
      const hint = nameMismatch
        ? ' Set MQTT_TLS_SERVERNAME to the broker certificate CN or a matching SAN (often nanomq-broker for NanoMQ dev certs) when MQTT_BROKER is a proxy hostname.'
        : '';
      throw new Error(`TLS validation failed for broker ${broker}: ${errMsg}${hint}`);
    }
  }

  /**
   * Ensure the service has a client certificate/key pair written locally for mTLS.
   * Controlled via CREATE_MQTT_CLIENT_CERT=true and device id via MQTT_CLIENT_CERT_DEVICE_ID.
   *
   * Idempotent: will not overwrite existing files.
   */
  private async ensureServerClientCertificate(): Promise<void> {
    const createFlag = process.env.CREATE_MQTT_CLIENT_CERT === 'true' || process.env.MQTT_CREATE_CLIENT_CERT === 'true';
    if (!createFlag) return;

    if (!this.config.mqtt.tls) {
      logger.warn('CREATE_MQTT_CLIENT_CERT requested but MQTT TLS config not enabled');
      return;
    }

    const runtimeDir = getMqttTlsRuntimeDir(this.config.storage.dataDir);
    const certPath = path.join(runtimeDir, 'client.crt');
    const keyPath = path.join(runtimeDir, 'client.key');

    // Optional skip if this run already has valid PEMs in the runtime dir (e.g. from env at startup).
    let certExists = fs.existsSync(certPath);
    let keyExists = fs.existsSync(keyPath);
    const isPemLike = (p: string) => {
      try {
        const c = fs.readFileSync(p, 'utf8');
        return c.includes('-----BEGIN') && c.includes('-----END');
      } catch {
        return false;
      }
    };
    if (certExists && keyExists) {
      const certValid = isPemLike(certPath);
      const keyValid = isPemLike(keyPath);
      if (certValid && keyValid) {
        logger.info('MQTT client cert/key already present in runtime dir; skipping generation', {
          certPath,
          keyPath
        });
        reloadMqttTlsClientPemFromRuntime(this.config);
        return;
      }
      logger.warn('Existing client cert/key in runtime dir are not valid PEM; regenerating', {
        certPath,
        keyPath,
        certValid,
        keyValid
      });
      certExists = false;
      keyExists = false;
    }

    if (!this.caService || !this.caService.isInitialized()) {
      logger.warn('CA service not initialized; cannot generate client certificate now');
      return;
    }

    const deviceId = process.env.MQTT_CLIENT_CERT_DEVICE_ID || process.env.MQTT_CLIENT_DEVICE_ID || 'server-client';
    const userId = process.env.MQTT_CLIENT_CERT_USER_ID || new mongoose.Types.ObjectId().toHexString();

    try {
      logger.info('Generating keypair and CSR for service client certificate', { deviceId });
      const keys = forge.pki.rsa.generateKeyPair(2048);

      const csr = forge.pki.createCertificationRequest();
      csr.publicKey = keys.publicKey;
      csr.setSubject([{ name: 'commonName', value: deviceId }]);
      csr.sign(keys.privateKey, forge.md.sha256.create());
      const csrPem = forge.pki.certificationRequestToPem(csr);

      // Sign CSR with CAService (will persist certificate in DB if available)
      const certDoc = await this.caService.signCSR(csrPem, deviceId, userId);
      const certificatePem = (certDoc as any).certificate as string;
      if (!certificatePem) {
        throw new Error('CAService.signCSR did not return certificate PEM');
      }

      // Ensure directories
      fs.mkdirSync(path.dirname(certPath), { recursive: true });
      fs.mkdirSync(path.dirname(keyPath), { recursive: true });

      // Write certificate and private key (private key is generated here; never stored in DB).
      // Overwrite existing files to ensure cert/key pair match.
      const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
      fs.writeFileSync(certPath, certificatePem, { encoding: 'utf8', mode: 0o644 });
      logger.info('Wrote generated client certificate', { certPath });
      fs.writeFileSync(keyPath, privateKeyPem, { encoding: 'utf8', mode: 0o600 });
      logger.info('Wrote generated client private key', { keyPath });
      reloadMqttTlsClientPemFromRuntime(this.config);
    } catch (err: any) {
      logger.error('Failed to generate client certificate', { error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  private async initializeMqttClient(): Promise<void> {
    logger.info('📡 Initializing MQTT client...');
    
    // Pre-check: DNS (and TLS handshake if TLS configured) to fail fast with actionable logs
    await this.verifyBrokerConnectivity().catch((err) => {
      logger.error('Broker connectivity pre-check failed', { error: err instanceof Error ? err.message : String(err) });
      throw err;
    });

    this.mqttClient = new MqttClientManager(this.config.mqtt);
    
    // Set up QoS 1 tracking callbacks for device liveness
    this.mqttClient.setDeviceCallbacks(
      // On device inactive (PUBACK timeout)
      async (deviceId: string) => {
        logger.warn('⚠️ [LIFECYCLE:PUBACK_TIMEOUT] Device unresponsive — removing from Redis + marking inactive', { deviceId });
        const removed = await this.activeDeviceCache.removeActive(deviceId);
        await this.deviceService.updateDeviceStatus(deviceId, 'inactive');
        logger.info('⚠️ [LIFECYCLE:PUBACK_TIMEOUT] Complete', { deviceId, removedFromRedis: removed });
      },
      // On device active (PUBACK received) — update lastSeen in Redis
      async (deviceId: string) => {
        logger.debug('✅ [LIFECYCLE:PUBACK_OK] Device confirmed message receipt', { deviceId });
        await this.activeDeviceCache.updateLastSeen(deviceId);
      }
    );
    
    await this.mqttClient.connect();
    
    // Subscribe to test topics for firmware testing
    await this.subscribeToTopics();
    
    logger.info('✅ MQTT client initialized with QoS 1 tracking');
  }

  private async subscribeToTopics(): Promise<void> {
    const root = this.config.mqtt.topicRoot;
    // proof.mqtt: device lifecycle + screen topics (Instagram, GMB, POS)
    const topics = [
      `${root}/+/active`,   // Device registration (connect)
      `${root}/+/lwt`,      // Last Will (broker when device disconnects)
      `${root}/+/status`,   // Device status (e.g. uptime)
      `${root}/+/instagram`, // Instagram screen (device → server if needed)
      `${root}/+/gmb`,      // Google My Business screen
      `${root}/+/pos`,      // POS screen
      `${root}/+/promotion` // Canvas / Promotion screen
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
          
          // ✅ ENFORCE: Ensure device is provisioned for every device message (development mode)
          const incomingDeviceId = this.extractDeviceId(receivedTopic);
          if (incomingDeviceId) {
            try {
              const allowedMsg = await this.ensureDeviceProvisioned(incomingDeviceId);
              if (!allowedMsg) {
                logger.warn('Dropping message from unprovisioned device', { topic: receivedTopic, deviceId: incomingDeviceId });
                return;
              }
            } catch (err: any) {
              logger.error('Error checking device provisioning for incoming message', { topic: receivedTopic, deviceId: incomingDeviceId, error: err?.message ?? String(err) });
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
          } else if (receivedTopic.endsWith('/instagram') || receivedTopic.endsWith('/gmb') || receivedTopic.endsWith('/pos')) {
            logger.debug('Screen message received', { topic: receivedTopic, screen: message.screen });
          } else {
            logger.debug('MQTT message received', { topic: receivedTopic, type: message.type || 'unknown', size: payload.length });
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

    logger.info('Subscribed to proof.mqtt topics', { count: topics.length, root });
  }

  /**
   * Validates that the device is allowed for mTLS-aligned registration (has active provisioned certificate).
   * When requireMtlsForRegistration is true and caService is available, only devices with an active cert can register.
   * @returns true if registration/request is allowed, false if device must be rejected
   */
  private async ensureDeviceProvisioned(deviceId: string): Promise<boolean> {
    if (!this.config.provisioning.requireMtlsForRegistration) {
      return true;
    }
    if (!this.caService) {
      return true; // No CA service: cannot enforce; allow (e.g. provisioning disabled)
    }
    const cert = await this.caService.findActiveCertificateByDeviceId(deviceId);
    if (!cert) return false;

    // Validate certificate CN matches expected prefix + deviceId
    let expectedCN: string;
    try {
      expectedCN = this.caService ? (this.caService as any).formatExpectedCN(deviceId) : (() => {
        const prefix = this.config.provisioning.cnPrefix || process.env.CERT_CN_PREFIX || 'PROOF';
        const normalizedPrefix = String(prefix).trim().replace(/[-_]+$/g, '');
        const device = String(deviceId).replace(new RegExp(`^${normalizedPrefix}[-_]*`), '');
        return `${normalizedPrefix}-${device}`;
      })();
    } catch {
      const prefix = this.config.provisioning.cnPrefix || process.env.CERT_CN_PREFIX || 'PROOF';
      expectedCN = `${String(prefix).trim()}-${deviceId}`;
    }
    if (cert.cn !== expectedCN) {
      logger.warn('Certificate CN mismatch for device - provisioning rejected', {
        deviceId,
        expectedCN,
        certCN: cert.cn
      });
      return false;
    }

    return true;
  }

  private async handleDeviceRegistration(topic: string, message: any): Promise<void> {
    const deviceId = this.extractDeviceId(topic);
    if (!deviceId) return;

    // ✅ mTLS: validate device has been provisioned (active certificate) before accepting registration
    const allowed = await this.ensureDeviceProvisioned(deviceId);
    if (!allowed) {
      logger.warn('🔒 Registration rejected: no active certificate for this device_id', { deviceId });
      await this.sendRegistrationResponse(deviceId, false, 'Device not provisioned.', false);
      return;
    }

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

    // Register device if not exists. Use topic-derived deviceId as canonical id so
    // DeviceService lookups and StatsPublisher topics match subscriber topics (e.g. proof.mqtt/<deviceId>/instagram).
    const existingDevice = await this.deviceService.getDevice(deviceId);
    if (!existingDevice) {
      await this.deviceService.registerDevice({
        deviceId,
        clientId: deviceId, // Must match topic segment so we publish to proof.mqtt/<deviceId>/...
        macID: deviceId,
        username: message.userId || message.user_id || 'unknown',
        status: 'active',
        lastSeen: new Date(),
        metadata: {
          mqttClientId: message.clientId, // Optional: actual MQTT client id for debugging
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

    // Cache active device in Redis with userId + user preferences (one-time MongoDB read)
    logger.info('📋 [LIFECYCLE:REGISTER] Caching device in Redis active list', { deviceId });
    await this.cacheActiveDevice(deviceId);
    logger.info('📋 [LIFECYCLE:REGISTER] Device registration complete', { deviceId });
  }

  /**
   * Cache a device as active in Redis with userId + user preferences.
   * Called once at registration time — avoids per-cycle MongoDB reads.
   */
  private async cacheActiveDevice(deviceId: string): Promise<void> {
    try {
      logger.info('📋 [LIFECYCLE:CACHE] Step 1/3 — Looking up Device in MongoDB', { deviceId });
      const deviceDoc = await Device.findOne({ clientId: deviceId });
      if (!deviceDoc) {
        logger.warn('📋 [LIFECYCLE:CACHE] Device not found in MongoDB — caching with defaults (no userId)', { deviceId });
        await this.activeDeviceCache.setActive({
          deviceId,
          userId: '',
          adManagementEnabled: true,
          brandCanvasEnabled: false,
          lastSeen: Date.now()
        });
        return;
      }

      logger.info('📋 [LIFECYCLE:CACHE] Step 2/3 — Device found, looking up User preferences', {
        deviceId,
        userId: deviceDoc.userId?.toString() || 'none',
        deviceStatus: deviceDoc.status
      });

      let adManagementEnabled = true;
      let brandCanvasEnabled = false;

      if (deviceDoc.userId) {
        const user = await User.findById(deviceDoc.userId);
        if (user) {
          adManagementEnabled = user.adManagementEnabled;
          brandCanvasEnabled = user.brandCanvasEnabled;
          logger.info('📋 [LIFECYCLE:CACHE] User preferences loaded from MongoDB', {
            deviceId,
            userId: deviceDoc.userId.toString(),
            adManagementEnabled,
            brandCanvasEnabled
          });
        } else {
          logger.warn('📋 [LIFECYCLE:CACHE] User document not found — using defaults', {
            deviceId,
            userId: deviceDoc.userId.toString()
          });
        }
      } else {
        logger.info('📋 [LIFECYCLE:CACHE] Device has no userId assigned — using default preferences', { deviceId });
      }

      logger.info('📋 [LIFECYCLE:CACHE] Step 3/3 — Writing to Redis', {
        deviceId,
        userId: deviceDoc.userId?.toString() || '',
        adManagementEnabled,
        brandCanvasEnabled
      });

      await this.activeDeviceCache.setActive({
        deviceId,
        userId: deviceDoc.userId?.toString() || '',
        adManagementEnabled,
        brandCanvasEnabled,
        lastSeen: Date.now()
      });
    } catch (err: unknown) {
      logger.error('❌ [LIFECYCLE:CACHE] Failed to cache active device in Redis', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
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
    
    // Remove from Redis active cache + mark inactive in MongoDB
    logger.info('💀 [LIFECYCLE:LWT] Removing device from Redis active cache', { deviceId });
    const removed = await this.activeDeviceCache.removeActive(deviceId);
    await this.deviceService.updateDeviceStatus(deviceId, 'inactive');
    logger.info('💀 [LIFECYCLE:LWT] Device disconnect processed', {
      deviceId,
      removedFromRedis: removed,
      mongoStatus: 'inactive'
    });
    
    // Note: No acknowledgment is sent for LWT since the device is already disconnected
  }

  private async handleDeviceStatus(topic: string, message: any): Promise<void> {
    const deviceId = this.extractDeviceId(topic);
    if (!deviceId) return;

    // ✅ mTLS: validate device is provisioned on every device request
    const allowed = await this.ensureDeviceProvisioned(deviceId);
    if (!allowed) {
      logger.warn('🔒 Status update ignored: device not provisioned', { deviceId });
      return;
    }

    logger.info('📊 Device Status Update', {
      deviceId,
      status: message.status,
      uptime: message.uptime
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
        topic: `${this.config.mqtt.topicRoot}/${deviceId}/registration_ack`,
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
        topic: `${this.config.mqtt.topicRoot}/${deviceId}/unregistration_ack`,
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
    const root = this.config.mqtt.topicRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = topic.match(new RegExp(`^${root}/([^/]+)/`));
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
    
    // Device configuration endpoint for devices to fetch broker settings
    try {
      const configRoutes = createConfigRoutes({
        config: this.config,
        caService: this.caService
      });
      this.httpServer.getApp().use('/api/v1', configRoutes);
      logger.info('✅ Device configuration route registered at /api/v1/mqtt-config');
    } catch (err: any) {
      logger.warn('⚠️ Failed to register device configuration route', { error: err instanceof Error ? err.message : String(err) });
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
      60 * 1000, // Publish every minute to /instagram, /gmb, /pos
      this.caService,
      this.config.provisioning.requireMtlsForRegistration
    );
    
    await this.statsPublisher.start();
    
    logger.info('✅ Stats publisher initialized - publishing every 60s to /instagram, /gmb, /pos, /promotion');
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
