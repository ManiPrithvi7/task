import { logger } from './utils/logger';
import { loadConfig, validateConfig, AppConfig, setMqttTlsClientPem } from './config';
import { HttpServer } from './servers/httpServer';
import { MqttClientManager } from './servers/mqttClient';
import { StatsPublisher } from './services/statsPublisher';
import { ConnectRefreshCoordinator } from './services/connectRefreshCoordinator';
import { DeferredDeviceWorkQueue } from './services/deferredDeviceWork';
import {
  flushMessageBuffer,
  routeMqttMessage,
  type MqttIngressHandlers,
  type MqttIngressRouterState
} from './services/mqttIngressRouter';
import { clearAllPublishHashesForDevice } from './services/mqttChangeDetection';
import { createConnectionsRoutes } from './routes/connectionsRoutes';
import { cacheUserIntegrations } from './services/userIntegrationCache';
import { GmbConnectPull } from './services/gmbConnectPull';
import { ProvisioningService } from './services/provisioningService';
import { CAService } from './services/caService';
import { AuthService } from './services/authService';
import { UserService } from './services/userService';
import { MongoService, createMongoService } from './services/mongoService';
import { RedisService, createRedisService } from './services/redisService';
import { DeviceService, getActiveDeviceCache, ActiveDeviceCache, type ActiveDevice } from './services/deviceService';
import {
  restoreActiveDevicesFromRedis,
  republishCachedScreensForActiveDevices
} from './services/startupCacheRepublish';
import { StimulateService } from './services/stimulateService';
import { InfluxService, createInfluxService, resetInfluxService } from './services/influxService';
import { AuditService, createAuditService } from './services/auditService';
import { TransparencyLog, createTransparencyLog } from './services/transparencyLog';
import {
  InstagramServerlessBridge,
  InstagramDirectFetchInvoker,
  InstagramPoller,
  REDIS_KEYS,
  areInstagramPollingScriptsLoaded,
  getInstagramPollingMetricsSnapshot,
  igPollMetricsInc,
  type InstagramFetchInvoker
} from './services/instagramService';
import { SessionService } from './services/sessionService';
import { Device, type IDevice } from './models/Device';
import { DeviceCertificate, DeviceCertificateStatus } from './models/DeviceCertificate';
import { User } from './models/User';
import { Social, Provider as SocialProvider } from './models/Social';
import { createProvisioningRoutes } from './routes/provisioningRoutes';
import { createConfigRoutes } from './routes/configRoutes';
import { createLifecycleRoutes } from './routes/lifecycleRoutes';
import { createRecoveryRoutes } from './routes/recoveryRoutes';
import { createOtaRoutes } from './routes/otaRoutes';
import { createOtaAdminRoutes } from './routes/otaAdminRoutes';
import { createWebhookRoutes, type OtaReleaseWebhookDeps } from './routes/webhookRoutes';
import { createDashboardRoutes } from './routes/dashboardRoutes';
import { createIntegrationRoutes } from './routes/integrationRoutes';
import { createInfluxQueryRoutes } from './routes/influxQueryRoutes';
import { createFirmwareStorageService } from './services/firmwareStorageService';
import { resolveOtaPublicBaseUrl } from './config/otaDefaults';
import {
  initOtaSigningState,
  OtaService,
  OtaCommandPublisher,
  OtaEventHandler,
  OtaRedisState
} from './services/otaService';
import { initOtaSigningKeyAudit } from './services/otaSigningKeyService';
import { createOtaReleaseLog } from './services/otaReleaseLog';
import { createRecoverySessionService } from './services/recoverySessionService';
import { getTokenStore } from './storage/tokenStore';
import * as dns from 'dns';
import * as tls from 'tls';
import * as fs from 'fs';
import * as path from 'path';
import * as forge from 'node-forge';
import mongoose from 'mongoose';
import {
  buildMqttTlsPrecheckOptions,
  normalizeTlsPem,
  resolveMqttTlsServername,
  type MqttTlsConnectMaterial
} from './utils/mqttTlsOptions';
import { validateKeyUsageAndEKU } from './utils/certValidator';
import { validateCertificateChain } from './services/chainValidator';
import { getAuditService, AuditEventType } from './services/auditService';

export class StatsMqttLite {
  private config: AppConfig;




  private httpServer!: HttpServer;
  private mqttClient!: MqttClientManager;
  
  // MongoDB-based services
  private sessionService!: SessionService;
  private deviceService!: DeviceService;
  // Note: User management handled by Next.js web app (shared database)
  
  // Stats publisher
  private statsPublisher!: StatsPublisher;
  private connectRefreshCoordinator?: ConnectRefreshCoordinator;
  
  // Provisioning services
  private provisioningService?: ProvisioningService;
  private caService?: CAService;
  private authService?: AuthService;
  private userService?: UserService;
  
  // MongoDB service
  private mongoService?: MongoService;
  
  // Redis service
  private redisService?: RedisService;

  private instagramServerlessBridge?: InstagramServerlessBridge;
  private instagramPoller?: InstagramPoller;
  /** TEMP STIMULATE — remove after testing */
  private stimulateService?: StimulateService;
  private influxService?: InfluxService;
  private auditService?: AuditService;
  private transparencyLog?: TransparencyLog;

  // OTA services
  private firmwareStorageService?: ReturnType<typeof createFirmwareStorageService>;
  private otaPublicBaseUrl?: string;
  private otaService?: OtaService;
  private otaCommandPublisher?: OtaCommandPublisher;
  private otaEventHandler?: OtaEventHandler;
  private otaRedisState?: OtaRedisState;

  // Active device cache (Redis-backed)
  private activeDeviceCache!: ActiveDeviceCache;

  private isIngressReady = false;
  private isServicesReady = false;
  private hasConnectedOnce = false;
  private readonly deferredWork = new DeferredDeviceWorkQueue();
  private readonly mqttIngressState: MqttIngressRouterState = {
    isServicesReady: false,
    startupTime: Date.now(),
    buffer: []
  };

  // Startup time for non-lifecycle grace period (set when ingress ready)
  private startupTime: number = Date.now();
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private lifecycleTopicsSubscribed = false;
  private nonLifecycleTopicsSubscribed = false;

  constructor() {
    this.config = loadConfig();
    validateConfig(this.config);
  }

  private getRedisClientOrNull() {
    if (!this.redisService) return null;
    if (!this.redisService.isRedisConnected()) return null;
    try {
      return this.redisService.getClient();
    } catch {
      return null;
    }
  }

  private async redisMarkDeviceActive(deviceId: string): Promise<void> {
    const client = this.getRedisClientOrNull();
    if (!client) return;
    try {
      const multi = client.multi();
      multi.sAdd('proof.mqtt:active:devices', deviceId);
      multi.expire('proof.mqtt:active:devices', 604800);
      await multi.exec();
    } catch (err: unknown) {
      logger.debug('Redis: failed to add device to active set', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private async redisRemoveDevice(deviceId: string): Promise<void> {
    const client = this.getRedisClientOrNull();
    if (!client) return;
    try {
      const multi = client.multi();
      multi.sRem('proof.mqtt:active:devices', deviceId);
      multi.del(`proof.mqtt:device:${deviceId}`);
      await multi.exec();
    } catch (err: unknown) {
      logger.debug('Redis: failed to remove device keys', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  /** Latest Instagram row for a Mongo User id (`Social` collection, name `Social` in Atlas). */
  private async loadLatestInstagramSocialForUser(
    userIdStr: string
  ): Promise<{ socialAccountId: string; accessToken: string; tokenExp: string } | null> {
    if (!mongoose.Types.ObjectId.isValid(userIdStr)) return null;
    try {
      const uid = new mongoose.Types.ObjectId(userIdStr);
      const ig = await Social.findOne({
        userId: uid,
        provider: SocialProvider.INSTAGRAM
      }).sort({ updatedAt: -1 });
      if (!ig) return null;
      return {
        socialAccountId: ig.socialAccountId,
        accessToken: ig.accessToken,
        tokenExp: ig.tokenExp
      };
    } catch (err: unknown) {
      logger.debug('Mongo: failed to load Instagram social for user', {
        userId: userIdStr,
        error: err instanceof Error ? err.message : String(err)
      });
      return null;
    }
  }


  async start(): Promise<void> {
    try {
      logger.info('🚀 Starting MQTT Publisher Lite...');
      logger.info('━'.repeat(50));

      // Phase 1: ingress-critical path (device /active must be handled ASAP)
      await this.initializeMongoDB();

      if (this.config.redis.enabled && this.config.redis.url) {
        await this.initializeRedis();
      } else if (this.config.redis.enabled) {
        logger.warn('⚠️  Redis enabled but REDIS_URL not set. Provisioning tokens will use in-memory storage.');
      }

      await this.initializeServices();

      if (
        this.config.provisioning.enabled &&
        this.config.provisioning.requireMtlsForRegistration
      ) {
        await this.initializeProvisioning();
      }

      await this.initializeMqttClient();
      await this.subscribeLifecycleTopics();
      await this.subscribeToTopics();

      this.isIngressReady = true;
      this.startupTime = Date.now();
      this.mqttIngressState.startupTime = this.startupTime;
      logger.info('🟢 MQTT ingress ready — accepting device connections');

      // Recover devices still marked active in Redis; push last-known screens
      // so MQTT-connected displays get values without waiting for a live fetch.
      await this.restoreActiveAndRepublishFromCache();

      void this.initializePhase2().catch((err: unknown) => {
        logger.error('Phase 2 initialization failed', {
          error: err instanceof Error ? err.message : String(err)
        });
      });

      logger.info('━'.repeat(50));
      logger.info('✅ MQTT Publisher Lite ingress started (Phase 2 warming up)');
      logger.info('');
      logger.info('📡 MQTT Broker:', `${this.config.mqtt.broker}:${this.config.mqtt.port}`);
      logger.info('🌐 HTTP API:', `http://${this.config.http.host}:${this.config.http.port}`);
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

  private async initializePhase2(): Promise<void> {
    logger.info('📈 Initializing InfluxDB...');
    await this.initializeInfluxDB();
    await this.initializePkiGovernance();

    if (this.config.provisioning.enabled && !this.caService) {
      await this.initializeProvisioning();
    }

    await this.initializeInstagramPoller();
    await this.initializeHttpServer();
    await this.initializeStatsPublisher();
    this.initializeConnectRefreshCoordinator();
    await this.initializeStimulateService();
    this.initializeKeepAlive();

    this.isServicesReady = true;
    this.mqttIngressState.isServicesReady = true;
    logger.info('🟢 All services ready — draining deferred work and message buffer');

    await this.processDeferredWork();
    await this.flushMqttMessageBuffer();
  }

  /** TEMP STIMULATE — remove after testing. In-process IG/GMB ramps when STIMULATE_DEVICE is set. */
  private async initializeStimulateService(): Promise<void> {
    if (!this.mqttClient) {
      logger.warn('[STIM] MQTT client missing — skip stimulate service');
      return;
    }
    this.stimulateService = new StimulateService();
    await this.stimulateService.start(
      this.mqttClient,
      this.redisService ?? null,
      this.config.mqtt.topicRoot,
      this.config.webhooks.mqttPublishEnabled
    );
  }

  private buildMqttIngressHandlers(): MqttIngressHandlers {
    return {
      onActive: (topic, message) => this.handleDeviceRegistration(topic, message),
      onLwt: (topic, message) => this.handleDeviceLWT(topic, message),
      onStatus: (topic, message) => this.handleDeviceStatus(topic, message),
      onOtaTelemetry: (topic, message) => this.handleDeviceOtaTelemetry(topic, message),
      onScreenEcho: (topic, message) => {
        logger.debug('Screen message received', {
          topic,
          screen: (message as { screen?: string })?.screen
        });
        return Promise.resolve();
      },
      onOther: (topic, message, payloadLength) => {
        logger.debug('MQTT message received', {
          topic,
          type: (message as { type?: string })?.type || 'unknown',
          size: payloadLength
        });
        return Promise.resolve();
      },
      updateLastSeen: (deviceId) =>
        this.deviceService.updateLastSeen(deviceId).catch(() => undefined),
      ensureProvisioned: (deviceId) => this.ensureDeviceProvisioned(deviceId),
      extractDeviceId: (topic) => this.extractDeviceId(topic)
    };
  }

  private async onMqttMessageReceived(
    receivedTopic: string,
    payload: Buffer,
    packet?: { retain?: boolean; qos?: number }
  ): Promise<void> {
    await routeMqttMessage(
      receivedTopic,
      payload,
      packet,
      this.buildMqttIngressHandlers(),
      this.mqttIngressState
    );
  }

  private async flushMqttMessageBuffer(): Promise<void> {
    await flushMessageBuffer(this.buildMqttIngressHandlers(), this.mqttIngressState);
  }

  private async processDeferredWork(): Promise<void> {
    const coordinator = this.connectRefreshCoordinator;
    if (!coordinator) {
      logger.warn('[DEFERRED_WORK] Connect refresh coordinator not ready — skipping drain');
      return;
    }

    const result = await this.deferredWork.processAll(async (item) => {
      if (item.type !== 'connect_refresh') return;
      try {
        await coordinator.refresh(item.deviceId);
      } catch (err: unknown) {
        logger.error('[DEFERRED_WORK] connect_refresh failed', {
          deviceId: item.deviceId,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err;
      }
    });

    if (result.processed > 0 || result.failed > 0 || result.skippedStale > 0) {
      logger.info('[DEFERRED_WORK] Drain complete', result);
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

    // Active device cache: keep local file across restart; Redis set is merged in
    // restoreActiveAndRepublishFromCache() after MQTT is up (no startup wipe).
    this.activeDeviceCache = getActiveDeviceCache();
    logger.info('✅ Active device cache initialized (local + Redis restore on MQTT ready)');

    logger.info('✅ Services initialized');
  }

  /**
   * After restart: merge Redis `proof.mqtt:active:devices` into local cache, then
   * republish Instagram (`device:followers:*`) and GMB (Redis location / Mongo) screens.
   */
  private async restoreActiveAndRepublishFromCache(): Promise<void> {
    try {
      const client = this.getRedisClientOrNull();
      await restoreActiveDevicesFromRedis(client, (deviceId) => this.cacheActiveDevice(deviceId));

      if (!this.mqttClient) {
        logger.warn('[STARTUP_CACHE] MQTT client missing — skip cache republish');
        return;
      }

      await republishCachedScreensForActiveDevices(
        this.mqttClient,
        this.config.mqtt.topicRoot,
        this.config.webhooks.mqttPublishEnabled
      );
    } catch (err: unknown) {
      logger.warn('[STARTUP_CACHE] Restore/republish failed (continuing startup)', {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private async initializeMongoDB(): Promise<void> {
    logger.info('🗃️  Initializing MongoDB (REQUIRED)...');

    if (!this.config.mongodb.uri) {
      throw new Error('MongoDB URI is required. Set MONGODB_URI environment variable.');
    }

    try {
      this.mongoService = createMongoService({
        uri: this.config.mongodb.uri,
        dbName: this.config.mongodb.dbName,
        maxPoolSize: this.config.mongodb.maxPoolSize,
        minPoolSize: this.config.mongodb.minPoolSize
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
          'If you see "Server selection timed out", check MongoDB Atlas Network Access (IP allowlist), VPN/firewall, and optionally MONGODB_SERVER_SELECTION_TIMEOUT_MS (default 30000).'
      );
      throw error;
    }
  }

  private async initializeRedis(): Promise<void> {
    logger.info('💾 Initializing Redis (Token Persistence)...');

    // Safety: if REDIS_URL points at localhost in production, fail fast.
    if (this.config.app.env === 'production' && this.config.redis.url) {
      try {
        const u = new URL(this.config.redis.url);
        const h = u.hostname;
        const isLocalhost = h === 'localhost' || h === '127.0.0.1' || h === '::1';
        if (isLocalhost) {
          throw new Error(
            'REDIS_URL points to localhost. On cloud platforms there is no Redis on localhost. ' +
            'Set REDIS_URL to your external Redis (e.g. Upstash). To run without Redis, set REDIS_ENABLED=false.'
          );
        }
      } catch {
        // ignore parse errors here; RedisService will surface connect errors
      }
    }

    this.redisService = createRedisService({
      url: this.config.redis.url,
      db: this.config.redis.db,
      keyPrefix: this.config.redis.keyPrefix,
    });

    // Check if Redis is configured before attempting connection
    if (!this.redisService.isRedisConfigured()) {
      logger.warn('⚠️  Redis enabled but no connection details provided. Provisioning tokens will use in-memory storage.');
      logger.warn('   Set REDIS_URL (recommended, e.g. Upstash).');
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
        'Set REDIS_URL (recommended, e.g. Upstash). Fix the connection or set REDIS_ENABLED=false to use in-memory tokens (not persistent).'
      );
    }
  }

  private async initializeInfluxDB(): Promise<void> {
    try {
      this.influxService = createInfluxService(this.config.influxdb);
      const healthy = await this.influxService.healthCheck();

      if (!healthy) {
        await resetInfluxService();
        this.influxService = undefined;
        throw new Error(
          'InfluxDB unreachable or misconfigured. Verify INFLUXDB_URL, INFLUXDB_TOKEN, INFLUXDB_ORG, INFLUXDB_BUCKET, INFLUXDB_COMPLIANCE_BUCKET.'
        );
      }

      logger.info('📈 InfluxDB connected', {
        url: this.config.influxdb.url,
        org: this.config.influxdb.org,
        bucket: this.config.influxdb.bucket,
        complianceBucket: this.config.influxdb.complianceBucket,
        diskQueue: this.config.influxdb.diskQueueEnabled,
        diskQueueSync: this.config.influxdb.diskQueueSyncOnAppend
      });
    } catch (err: unknown) {
      await resetInfluxService();
      this.influxService = undefined;
      throw err;
    }
  }

  /**
   * PKI governance (audit-only rollout): hash-chained audit log + optional CT log.
   * Rollback: set PKI_AUDIT_LOG_ENABLED=false and TRANSPARENCY_LOG_ENABLED=false, redeploy.
   */
  private async initializePkiGovernance(): Promise<void> {
    if (!this.config.provisioning.auditLogEnabled) {
      logger.info('PKI audit log disabled (PKI_AUDIT_LOG_ENABLED=false)');
      return;
    }

    const fallbackLogPath = path.join(
      this.config.provisioning.caStoragePath,
      'audit.log'
    );

    this.auditService = createAuditService({ fallbackLogPath });
    await this.auditService.initialize();
    logger.info('PKI AuditService initialized (hash-chain)');

    if (!this.config.provisioning.transparencyLogEnabled) {
      logger.info('PKI transparency log disabled (TRANSPARENCY_LOG_ENABLED=false)');
      return;
    }

    if (!this.influxService) {
      logger.warn(
        'TRANSPARENCY_LOG_ENABLED=true but InfluxDB unavailable — CT log disabled (audit log still active via file fallback)'
      );
      return;
    }

    this.transparencyLog = createTransparencyLog({ enabled: true });
    await this.transparencyLog.initialize();
    logger.info('PKI TransparencyLog initialized (Merkle tree → Influx ct_log)');
  }

  private async initializeInstagramPoller(): Promise<void> {
    if (!this.redisService?.isRedisConnected()) {
      logger.info('📉 Instagram poller disabled (Redis not connected)');
      return;
    }

    const igPoll = this.config.instagramPolling!;
    const sl = this.config.instagramServerless;
    const fetchUrl = sl?.fetchUrl?.trim();

    let fetchInvoker: InstagramFetchInvoker;
    if (fetchUrl) {
      this.instagramServerlessBridge = new InstagramServerlessBridge(sl!, this.mqttClient);
      fetchInvoker = this.instagramServerlessBridge;
      logger.info('📡 Instagram fetch mode: serverless (INSTAGRAM_SERVERLESS_URL set)');
    } else {
      this.instagramServerlessBridge = undefined;
      fetchInvoker = new InstagramDirectFetchInvoker(this.mqttClient);
      logger.info(
        '📡 Instagram fetch mode: direct (Graph API on this server). Set INSTAGRAM_SERVERLESS_URL to offload to a worker.'
      );
    }

    this.instagramPoller = new InstagramPoller(fetchInvoker, this.redisService, {
      priorityIntervalMs: igPoll.priorityIntervalMs,
      backgroundIntervalMs: igPoll.backgroundIntervalMs,
      priorityTtlMs: igPoll.priorityTtlMs,
      batchSize: igPoll.batchSize,
      backoffThreshold: igPoll.backoffThreshold,
      backoffWindowMs: igPoll.backoffWindowMs,
      priorityCapPerCycle: igPoll.priorityCapPerCycle,
      fetchDedupeWindowMs: igPoll.fetchDedupeWindowMs,
      priorityZsetMaxMembers: igPoll.priorityZsetMaxMembers,
      priorityRefreshMaxDeltaMs: igPoll.priorityRefreshMaxDeltaMs,
      priorityAbsoluteMaxFutureMs: igPoll.priorityAbsoluteMaxFutureMs,
      backgroundCapPerCycle: igPoll.backgroundCapPerCycle,
      backgroundFairRotate: igPoll.backgroundFairRotate,
      globalFetchBudgetPerMinute: igPoll.globalFetchBudgetPerMinute
    });

    await this.instagramPoller.start();
    logger.info('✅ Instagram poller initialized (dual schedulers enabled)');
  }

  /** Readiness for Instagram polling (Redis + Lua + poller; serverless URL optional). */
  private async buildReadinessPayload(): Promise<Record<string, unknown>> {
    const serverlessConfigured = Boolean(this.config.instagramServerless?.fetchUrl?.trim());
    const redisOk = this.redisService?.isRedisConnected() === true;
    const poller = this.instagramPoller;
    const pollerLive = poller != null;
    const pollerRunning = poller ? poller.getRunning() : false;
    const pollerScripts = poller ? poller.getScriptsReady() : false;
    const luaLoaded = areInstagramPollingScriptsLoaded();
    const fetchMode: 'serverless' | 'direct' | 'off' = !pollerLive
      ? 'off'
      : serverlessConfigured
        ? 'serverless'
        : 'direct';
    const ready =
      !pollerLive || (redisOk && pollerRunning && pollerScripts && luaLoaded);
    return {
      ready,
      instagram_fetch_mode: fetchMode,
      instagram_pipeline_desired: serverlessConfigured,
      instagram_serverless_configured: serverlessConfigured,
      redis_connected: redisOk,
      instagram_poller_running: pollerRunning,
      instagram_poller_scripts_ready: pollerScripts,
      instagram_polling_lua_loaded: luaLoaded,
      metrics: getInstagramPollingMetricsSnapshot()
    };
  }

  private async setDevicePowerSaveFlag(deviceId: string): Promise<void> {
    if (!this.redisService?.isRedisConnected()) return;
    try {
      await this.redisService.getClient().set(REDIS_KEYS.igPowerSave(deviceId), '1', { EX: 86400 });
      logger.debug('[IG_POLL] power_save flag set for device', { deviceId });
    } catch (err: unknown) {
      logger.warn('[IG_POLL] power_save set failed', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
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
    if (process.env.MQTT_TLS_SKIP_PRECHECK === 'true') {
      logger.warn('MQTT TLS pre-check skipped (MQTT_TLS_SKIP_PRECHECK=true)');
      return;
    }

    const broker = this.config.mqtt.broker;
    const port = this.config.mqtt.port;

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

    const caPem = tlsCfg.caPem?.includes('-----BEGIN') ? normalizeTlsPem(tlsCfg.caPem) : undefined;
    if (!caPem) {
      logger.warn('MQTT TLS enabled but no usable CA PEM; skipping TLS pre-check');
      return;
    }

    const servername = tlsCfg.servername || resolveMqttTlsServername(broker);
    const tlsMaterial: MqttTlsConnectMaterial = {
      caPem,
      clientCertPem: tlsCfg.clientCertPem,
      clientKeyPem: tlsCfg.clientKeyPem,
      rejectUnauthorized: tlsCfg.rejectUnauthorized !== false,
      servername
    };

    if (servername !== broker) {
      logger.info('MQTT TLS pre-check: TCP host differs from cert SNI', { broker, servername });
    }

    try {
      logger.info('MQTT TLS pre-check', { broker, port, servername, mTLS: !!(tlsCfg.clientCertPem && tlsCfg.clientKeyPem) });
      await new Promise<void>((resolve, reject) => {
        const socket = tls.connect(
          buildMqttTlsPrecheckOptions(tlsMaterial, broker, port),
          () => {
            if (!socket.authorized) {
              const authErr = socket.authorizationError || 'TLS authorization failed';
              socket.end();
              reject(new Error(String(authErr)));
              return;
            }
            const peer = socket.getPeerCertificate(true) as tls.PeerCertificate | undefined;
            logger.info('TLS handshake succeeded', {
              broker,
              protocol: socket.getProtocol(),
              cipher: socket.getCipher()?.name,
              subject: peer?.subject || null
            });
            socket.end();
            resolve();
          }
        );

        socket.on('error', (e) => {
          reject(e instanceof Error ? e : new Error(String(e)));
        });

        setTimeout(() => {
          socket.destroy();
          reject(new Error('TLS handshake timeout'));
        }, 10000);
      });
    } catch (err: any) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('TLS handshake/check failed', { broker, servername, error: errMsg });
      const nameMismatch =
        /altnames|Hostname\/IP does not match|does not match certificate/i.test(errMsg);
      const earlyDisconnect = /disconnected before secure TLS connection|UNEXPECTED_EOF|decode_error/i.test(
        errMsg
      );
      let hint = '';
      if (nameMismatch) {
        hint =
          ' Set MQTT_TLS_SERVERNAME to a broker cert SAN (e.g. broker.withproof.io) when MQTT_BROKER is a Railway proxy hostname.';
      } else if (earlyDisconnect) {
        hint =
          ' Broker may be sending a malformed TLS ServerHello (NanoMQ cert/key on Railway). Re-run npm run pki:broker, update NANOMQ_TLS_* on the broker service, or set MQTT_TLS_SKIP_PRECHECK=true after verifying with npm run pki:verify.';
      }
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

    if (
      this.config.mqtt.tls.clientCertPem?.includes('-----BEGIN') &&
      this.config.mqtt.tls.clientKeyPem?.includes('-----BEGIN')
    ) {
      logger.info('MQTT client cert/key already loaded from env; skipping CREATE_MQTT_CLIENT_CERT generation');
      return;
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

      const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
      setMqttTlsClientPem(this.config, certificatePem, privateKeyPem);
      logger.info('MQTT client certificate loaded in-memory (set MQTT_TLS_CLIENT_*_BASE64 to persist across restarts)', {
        deviceId
      });
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
      // On device inactive (PUBACK timeout) — Redis only; Mongo status unchanged (presence → Influx later)
      async (deviceId: string) => {
        logger.warn('⚠️ [LIFECYCLE:PUBACK_TIMEOUT] Device unresponsive — removing from Redis active cache', { deviceId });
        const removed = await this.activeDeviceCache.removeActive(deviceId);
        await this.redisRemoveDevice(deviceId);
        logger.info('⚠️ [LIFECYCLE:PUBACK_TIMEOUT] Complete', { deviceId, removedFromRedis: removed });
      },
      // On device active (PUBACK received) — update lastSeen in Redis
      async (deviceId: string) => {
        logger.debug('✅ [LIFECYCLE:PUBACK_OK] Device confirmed message receipt', { deviceId });
        await this.activeDeviceCache.updateLastSeen(deviceId);
        await this.redisMarkDeviceActive(deviceId);
      }
    );
    
    await this.mqttClient.connect();

    this.mqttClient.on('brokerConnect', ({ reconnect }: { reconnect: boolean }) => {
      if (reconnect && this.isIngressReady) {
        logger.info('MQTT reconnected — re-subscribing to topics');
        void this.subscribeLifecycleTopics().catch((err: unknown) => {
          logger.error('MQTT lifecycle re-subscribe failed', {
            error: err instanceof Error ? err.message : String(err)
          });
        });
        void this.subscribeToTopics().catch((err: unknown) => {
          logger.error('MQTT topic re-subscribe failed', {
            error: err instanceof Error ? err.message : String(err)
          });
        });
      }
      this.hasConnectedOnce = true;
    });

    logger.info('✅ MQTT client initialized with QoS 1 tracking');
  }

  private async subscribeLifecycleTopics(): Promise<void> {
    const root = this.config.mqtt.topicRoot;
    const topics = [`${root}/+/active`, `${root}/+/lwt`];

    for (const topic of topics) {
      await this.mqttClient.subscribe(topic, (receivedTopic, payload, packet) => {
        void this.onMqttMessageReceived(receivedTopic, payload, packet);
      });
    }

    this.lifecycleTopicsSubscribed = true;
    logger.info('Subscribed to lifecycle topics', { topics, root });
  }

  private async subscribeToTopics(): Promise<void> {
    const root = this.config.mqtt.topicRoot;
    const topics = [
      `${root}/+/status`,
      `${root}/+/telemetry`,
      `${root}/+/instagram`,
      `${root}/+/gmb`,
      `${root}/+/promotion`
    ];

    for (const topic of topics) {
      await this.mqttClient.subscribe(topic, (receivedTopic, payload, packet) => {
        void this.onMqttMessageReceived(receivedTopic, payload, packet);
      });
    }

    this.nonLifecycleTopicsSubscribed = true;
    logger.info('Subscribed to non-lifecycle proof.mqtt topics', { count: topics.length, root });
  }

  /**
   * Validates that the device is allowed for mTLS-aligned registration (has active provisioned certificate).
   * Enforces CN match, optional KU/EKU, and chain validation when enabled in config.
   */
  private async ensureDeviceProvisioned(deviceId: string): Promise<boolean> {
    if (!this.config.provisioning.requireMtlsForRegistration) {
      return true;
    }
    if (!this.caService) {
      return true;
    }

    const cert = await this.caService.findActiveCertificateByDeviceId(deviceId, {
      slots: ['primary', 'staging']
    });
    if (!cert) {
      const auditSvc = getAuditService();
      if (auditSvc) {
        await auditSvc
          .logEvent({
            event: AuditEventType.DEVICE_AUTH_FAILED,
            deviceId,
            details: { reason: 'NO_ACTIVE_CERTIFICATE' }
          })
          .catch(() => undefined);
      }
      return false;
    }

    const certSlot = cert.slot ?? 'primary';

    let expectedCN: string;
    try {
      expectedCN = this.caService.formatExpectedCN(deviceId);
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
      const auditSvc = getAuditService();
      if (auditSvc) {
        await auditSvc
          .logEvent({
            event: AuditEventType.DEVICE_AUTH_FAILED,
            deviceId,
            certificateFingerprint: cert.fingerprint,
            details: { reason: 'CN_MISMATCH', expectedCN, certCN: cert.cn }
          })
          .catch(() => undefined);
      }
      return false;
    }

    if (this.config.provisioning.enforceRuntimeKuEku && cert.certificate) {
      const kuResult = validateKeyUsageAndEKU(cert.certificate);
      if (!kuResult.valid) {
        logger.warn('[PKI:KU_EKU] Certificate validation failed — rejecting', {
          deviceId,
          errors: kuResult.errors
        });
        const auditSvc = getAuditService();
        if (auditSvc) {
          await auditSvc
            .logEvent({
              event: AuditEventType.KU_EKU_VALIDATION_FAILED,
              deviceId,
              certificateFingerprint: cert.fingerprint,
              details: {
                reason: 'KU_EKU_INVALID',
                errors: kuResult.errors,
                missingExtensions: kuResult.errors.filter((e) => e.includes('missing')),
                hasDigitalSignature: kuResult.hasDigitalSignature,
                hasClientAuth: kuResult.hasClientAuth,
                hasProhibitedKeyCertSign: kuResult.hasProhibitedKeyCertSign,
                slot: certSlot
              }
            })
            .catch(() => undefined);
        }
        return false;
      }
    }

    if (
      this.config.provisioning.chainValidationEnabled &&
      cert.certificate &&
      cert.ca_certificate
    ) {
      try {
        const rootCAPem = this.caService.getRootCACertificate();
        const chainResult = validateCertificateChain(cert.certificate, [], rootCAPem);
        if (!chainResult.valid) {
          logger.warn('[PKI:CHAIN] Certificate chain validation failed — rejecting', {
            deviceId,
            errors: chainResult.errors
          });
          const auditSvc = getAuditService();
          if (auditSvc) {
            await auditSvc
              .logEvent({
                event: AuditEventType.CHAIN_VALIDATION_FAILED,
                deviceId,
                certificateFingerprint: cert.fingerprint,
                details: {
                  reason: 'CHAIN_INVALID',
                  failurePoint: chainResult.errors[0] ?? 'unknown',
                  errors: chainResult.errors,
                  chainSubjects: chainResult.chainSubjects,
                  slot: certSlot
                }
              })
              .catch(() => undefined);
          }
          return false;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('[PKI:CHAIN] Chain validation error — rejecting', {
          deviceId,
          error: msg
        });
        const auditSvc = getAuditService();
        if (auditSvc) {
          await auditSvc
            .logEvent({
              event: AuditEventType.CHAIN_VALIDATION_FAILED,
              deviceId,
              certificateFingerprint: cert.fingerprint,
              details: { reason: 'CHAIN_VALIDATION_ERROR', failurePoint: msg, slot: certSlot }
            })
            .catch(() => undefined);
        }
        return false;
      }
    }

    const auditSvc = getAuditService();
    if (auditSvc) {
      await auditSvc
        .logEvent({
          event: AuditEventType.DEVICE_AUTH_SUCCESS,
          deviceId,
          certificateFingerprint: cert.fingerprint,
          details: {
            slot: certSlot,
            cn: cert.cn,
            expiresAt: cert.expires_at?.toISOString?.() ?? String(cert.expires_at)
          }
        })
        .catch(() => undefined);
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

    // if (message?.power_save === true || message?.power_mode === 'low') {
    //   await this.setDevicePowerSaveFlag(deviceId);
    // }

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
      logger.info('✅ Existing device reconnected (Redis cache only; Mongo status unchanged)', { deviceId });
      
      // Send registration confirmation for existing device
      await this.sendRegistrationResponse(deviceId, true, 'Device reconnected successfully', false);
    }

    // Cache active device in Redis with userId + user preferences (one-time MongoDB read)
    logger.info('📋 [LIFECYCLE:REGISTER] Caching device in Redis active list', { deviceId });
    await this.cacheActiveDevice(deviceId);
    await this.redisMarkDeviceActive(deviceId);

    const mongoUserId = (await Device.findOne({ clientId: deviceId }).select({ userId: 1 }).lean())?.userId
      ?.toString();
    if (mongoUserId) {
      void cacheUserIntegrations(mongoUserId).catch((err: unknown) => {
        logger.warn('[LIFECYCLE:REGISTER] Integration cache warm failed', {
          deviceId,
          userId: mongoUserId,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    }

    this.deferredWork.enqueueConnectRefresh(deviceId);
    if (this.isServicesReady) {
      void this.processDeferredWork().catch((err: unknown) => {
        logger.error('[DEFERRED_WORK] Failed after registration', {
          deviceId,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    }

    // TEMP STIMULATE — /active on allowlisted device restarts ramp from 0
    if (this.stimulateService) {
      void this.stimulateService.resetOnDeviceConnect(deviceId).catch((err: unknown) => {
        logger.warn('[STIM] resetOnDeviceConnect failed', {
          deviceId,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    }

    logger.info('📋 [LIFECYCLE:REGISTER] Device registration complete', { deviceId });

    void this.deliverOtaOnRegistration(deviceId, message.appVersion || message.app_version);
  }

  private async deliverOtaOnRegistration(deviceId: string, appVersion?: string): Promise<void> {
    if (!this.config.ota?.enabled || !this.otaService) {
      return;
    }

    let currentVersion =
      typeof appVersion === 'string' && appVersion.trim() ? appVersion.trim() : undefined;

    if (!currentVersion || currentVersion === '1.0.0') {
      const device = await Device.findOne({ clientId: deviceId }).select({ firmwareVersion: 1 });
      if (device?.firmwareVersion?.trim()) {
        currentVersion = device.firmwareVersion.trim();
      }
    }

    if (!currentVersion) {
      return;
    }

    try {
      await this.otaService.deliverPendingToDevice(deviceId, currentVersion);
    } catch (err: unknown) {
      logger.warn('[OTA] Registration delivery failed', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  /**
   * Load Device from MongoDB, Instagram tokens from `Social`, write active device + Redis IG meta.
   */
  private async cacheActiveDevice(deviceId: string): Promise<void> {
    try {
      logger.info('📋 [LIFECYCLE:CACHE] Step 1/2 — Device lookup (MongoDB)', { deviceId });
      const deviceDoc = await Device.findOne({ clientId: deviceId });
      if (!deviceDoc) {
        logger.warn('📋 [LIFECYCLE:CACHE] Device not found in MongoDB — caching defaults only', { deviceId });
        await this.activeDeviceCache.setActive({
          deviceId,
          userId: '',
          lastSeen: Date.now()
        });
        return;
      }

      logger.info('📋 [LIFECYCLE:CACHE] Step 2/2 — Social (Instagram) for device', {
        deviceId,
        userId: deviceDoc.userId?.toString() || 'none',
        deviceStatus: deviceDoc.status
      });

      const mongoUserId = deviceDoc.userId?.toString() || '';
      const hasLinkedMongoUser = Boolean(mongoUserId && mongoose.Types.ObjectId.isValid(mongoUserId));

      if (!hasLinkedMongoUser) {
        logger.info('📋 [LIFECYCLE:CACHE] Device has no Mongo userId — cannot load Instagram from Social', { deviceId });
      }

      const igFromSocial = hasLinkedMongoUser ? await this.loadLatestInstagramSocialForUser(mongoUserId) : null;
      if (hasLinkedMongoUser && !igFromSocial) {
        logger.warn('📋 [LIFECYCLE:CACHE] No INSTAGRAM `Social` row for owner — add Instagram for this user in the web app', {
          deviceId,
          userId: mongoUserId
        });
      }

      const active: ActiveDevice = {
        deviceId,
        userId: mongoUserId,
        lastSeen: Date.now(),
        ...(igFromSocial
          ? { instagramAccountId: igFromSocial.socialAccountId, accessToken: igFromSocial.accessToken }
          : {})
      };

      await this.activeDeviceCache.setActive(active);

      logger.info('📋 [LIFECYCLE:CACHE] Active device record written (Mongo → file + Redis IG key)', {
        deviceId,
        userId: mongoUserId || '(none)',
        instagramFromSocial: Boolean(igFromSocial)
      });

      const client = this.getRedisClientOrNull();
      if (!client) return;

      try {
        const deviceMetaKey = `proof.mqtt:device:${deviceId}`;
        if (igFromSocial) {
          await client.set(
            deviceMetaKey,
            JSON.stringify({
              instagramAccountId: igFromSocial.socialAccountId,
              accessToken: igFromSocial.accessToken,
              tokenExpiresAt: igFromSocial.tokenExp || undefined
            }),
            { EX: 604800 }
          );
        } else {
          await client.del(deviceMetaKey);
        }
      } catch (err: unknown) {
        logger.debug('Redis: failed to sync proof.mqtt:device meta', {
          deviceId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    } catch (err: unknown) {
      logger.error('❌ [LIFECYCLE:CACHE] Failed to cache active device', {
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
   *    4. Server receives LWT and clears Redis active cache (Mongo status unchanged)
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
    
    // Remove from Redis active cache only; Mongo status unchanged (presence → Influx later)
    logger.info('💀 [LIFECYCLE:LWT] Removing device from Redis active cache', { deviceId });
    const removed = await this.activeDeviceCache.removeActive(deviceId);
    await this.redisRemoveDevice(deviceId);

    const clearedPublishHashes = await clearAllPublishHashesForDevice(deviceId);
    if (clearedPublishHashes > 0) {
      logger.info('💀 [LIFECYCLE:LWT] Cleared MQTT publish dedupe hashes', {
        deviceId,
        clearedPublishHashes
      });
    }

    // TEMP STIMULATE — stop loops so cache TTL can expire during disconnection
    if (this.stimulateService) {
      void this.stimulateService.stopOnDeviceDisconnect(deviceId).catch((err: unknown) => {
        logger.warn('[STIM] stopOnDeviceDisconnect failed', {
          deviceId,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    }

    logger.info('💀 [LIFECYCLE:LWT] Device disconnect processed', {
      deviceId,
      removedFromRedis: removed
    });

    // Maintain polling sets for Instagram dual schedulers
    try {
      if (this.redisService?.isRedisConnected()) {
        const client = this.redisService.getClient();
        const multi = client.multi();
        multi.zRem(REDIS_KEYS.priorityZset, deviceId);
        multi.del(REDIS_KEYS.deviceFetchHistory(deviceId));
        multi.del(REDIS_KEYS.deviceFollowers(deviceId));
        multi.del(`instagram:pending:${deviceId}`);
        await multi.exec();
      }
    } catch (err: unknown) {
      logger.warn('Failed to cleanup Instagram polling keys on LWT', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    }

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

    const eventType = message?.type || message?.event || message?.status;

    if (this.otaEventHandler && eventType && String(eventType).startsWith('ota_')) {
      await this.otaEventHandler.handle(deviceId, message);
    }

    if (eventType && this.influxService) {
      void this.influxService.writeOtaTelemetry({
        deviceId,
        event: String(eventType),
        timestamp: message.timestamp,
        current_version: message.current_version || message.fw_version,
        target_version: message.target_version,
        from_version: message.from_version,
        to_version: message.to_version,
        attempted_version: message.attempted_version,
        reverted_to: message.reverted_to,
        fw_version: message.fw_version,
        reason: message.reason,
        error_code: message.error_code,
        error_message: message.error_message,
        partition: message.partition,
        boot_reason: message.boot_reason,
        uptime_s: message.uptime_s ?? message.uptime,
        free_heap: message.free_heap,
        battery: message.battery,
        signal_strength: message.signal_strength,
        ota_state: message.ota_state,
        checks_passed: message.checks_passed,
        checks_total: message.checks_total,
        attempt_number: message.attempt_number,
        attempt_count: message.attempt_count,
        sha256_match: message.sha256_match,
        signature_valid: message.signature_valid,
        time_sync_ok: message.time_sync_ok,
        download_duration_ms: message.download_duration_ms,
        validation_duration_ms: message.validation_duration_ms,
        firmware_size: message.firmware_size,
        cooldown_remaining_s: message.cooldown_remaining_s,
        source_topic: 'status'
      }).catch(() => undefined);
    }

    logger.info('📊 Device Status Update', {
      deviceId,
      status: message.status,
      eventType,
      uptime: message.uptime
    });
  }

  private async handleDeviceOtaTelemetry(topic: string, message: any): Promise<void> {
    const deviceId = this.extractDeviceId(topic);
    if (!deviceId) return;

    const allowed = await this.ensureDeviceProvisioned(deviceId);
    if (!allowed) {
      logger.warn('🔒 OTA telemetry ignored: device not provisioned', { deviceId });
      return;
    }

    const eventType = message?.ota_status || message?.event || message?.type || 'telemetry';

    if (this.otaEventHandler && String(eventType).startsWith('ota_')) {
      await this.otaEventHandler.handle(deviceId, message);
    }

    if (this.influxService) {
      void this.influxService.writeOtaTelemetry({
        deviceId,
        event: String(eventType),
        timestamp: message.timestamp,
        current_version: message.current_version || message.fw_version,
        target_version: message.target_version,
        from_version: message.from_version,
        to_version: message.to_version,
        offered_version: message.offered_version,
        attempted_version: message.attempted_version,
        reverted_to: message.reverted_to,
        fw_version: message.fw_version,
        ota_progress_pct: message.ota_progress_pct ?? message.progress,
        ota_bytes: message.ota_bytes,
        ota_bytes_total: message.ota_bytes_total,
        elapsed_ms: message.elapsed_ms,
        estimated_remaining_ms: message.estimated_remaining_ms,
        download_duration_ms: message.download_duration_ms,
        validation_duration_ms: message.validation_duration_ms,
        reason: message.reason,
        error_code: message.error_code,
        error_message: message.error_message,
        http_code: message.http_code,
        expected_sha256: message.expected_sha256,
        computed_sha256: message.computed_sha256,
        uptime_s: message.uptime_s ?? message.uptime,
        free_heap: message.free_heap,
        battery: message.battery,
        signal_strength: message.signal_strength,
        wifi_rssi: message.wifi_rssi,
        cert_days_remaining: message.cert_days_remaining,
        cert_renewal_needed: message.cert_renewal_needed,
        partition: message.partition,
        boot_reason: message.boot_reason,
        ota_state: message.ota_state,
        checks_passed: message.checks_passed,
        checks_total: message.checks_total,
        attempt_number: message.attempt_number,
        attempt_count: message.attempt_count,
        firmware_size: message.firmware_size ?? message.firmwareSize ?? message.sizeBytes,
        cooldown_remaining_s: message.cooldown_remaining_s,
        sha256_match: message.sha256_match,
        signature_valid: message.signature_valid,
        time_sync_ok: message.time_sync_ok,
        source_topic: 'telemetry'
      }).catch(() => undefined);
    }

    logger.info('📊 OTA Telemetry', {
      deviceId,
      event: eventType,
      progress: message.ota_progress_pct ?? message.progress,
      free_heap: message.free_heap,
      uptime: message.uptime_s ?? message.uptime
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

    let otaReleaseWebhook: OtaReleaseWebhookDeps | undefined;

    if (this.config.ota?.enabled) {
      this.initializeOtaServices();
      if (this.config.ota.releaseWebhookSecret && this.otaService) {
        otaReleaseWebhook = {
          secret: this.config.ota.releaseWebhookSecret,
          otaService: this.otaService
        };
      }
    }

    const webhookRoutes = createWebhookRoutes({
      mqttClient: this.mqttClient,
      topicRoot: this.config.mqtt.topicRoot,
      webhookConfig: this.config.webhooks,
      appEnv: this.config.app.env,
      otaReleaseWebhook
    });

    this.httpServer = new HttpServer(
      this.config.http,
      this.sessionService,
      this.deviceService,
      this.mqttClient,
      () => this.buildReadinessPayload(),
      [webhookRoutes]
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

      const recoverySessionService = createRecoverySessionService(
        this.config.redis.keyPrefix || 'proof-mqtt:',
        this.config.auth.secret
      );

      const lifecycleRoutes = createLifecycleRoutes({
        caService: this.caService,
        recoverySessionService
      });
      this.httpServer.getApp().use('/api/v1', lifecycleRoutes);
      logger.info('✅ Lifecycle routes registered at /api/v1');

      const recoveryRoutes = createRecoveryRoutes({
        recoverySessionService,
        authService: this.authService
      });
      this.httpServer.getApp().use('/api/v1', recoveryRoutes);
      logger.info('✅ Recovery routes registered at /api/v1/recovery');

      // Compatibility alias (older clients): /api/recovery/* instead of /api/v1/recovery/*
      this.httpServer.getApp().use('/api', recoveryRoutes);
      logger.info('✅ Recovery routes registered at /api/recovery (alias)');
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

    if (this.config.ota?.enabled) {
      if (
        this.firmwareStorageService &&
        this.otaService &&
        this.otaCommandPublisher &&
        this.otaEventHandler
      ) {
        const publicBaseUrl = this.otaPublicBaseUrl!;

        const otaRoutes = createOtaRoutes({
          otaConfig: this.config.ota,
          otaService: this.otaService,
          storage: this.firmwareStorageService,
          eventHandler: this.otaEventHandler,
          getRedisClient: () => this.getRedisClientOrNull(),
          redisKeyPrefix: this.config.redis.keyPrefix || 'proof-mqtt:'
        });
        this.httpServer.getApp().use('/api/v1', otaRoutes);
        logger.info('✅ OTA device routes registered at /api/v1/ota/*');

        if (this.authService || this.config.auth.secret) {
          if (!this.authService && this.config.auth.secret) {
            this.authService = new AuthService(this.config.auth.secret);
          }
          const adminAuth = this.authService!;
          const otaAdminRoutes = createOtaAdminRoutes({
            otaConfig: this.config.ota,
            authService: adminAuth,
            storage: this.firmwareStorageService,
            otaService: this.otaService,
            commandPublisher: this.otaCommandPublisher,
            publicBaseUrl
          });
          this.httpServer.getApp().use('/api/v1/admin/ota', otaAdminRoutes);
          logger.info('✅ OTA admin routes registered at /api/v1/admin/ota/*');
        } else {
          logger.warn('⚠️ OTA admin routes skipped — AuthService not initialized');
        }
      }
    }
    
    if (this.influxService) {
      if (this.authService || this.config.auth?.secret) {
        if (!this.authService && this.config.auth?.secret) {
          this.authService = new AuthService(this.config.auth.secret);
        }
        if (this.authService) {
          const dashboardRoutes = createDashboardRoutes({ authService: this.authService });
          this.httpServer.getApp().use('/api/v1', dashboardRoutes);
          logger.info('✅ Dashboard routes registered at /api/v1/dashboard/*');

          const integrationRoutes = createIntegrationRoutes({ authService: this.authService });
          this.httpServer.getApp().use('/api/v1', integrationRoutes);
          logger.info('✅ Integration routes registered at /api/v1/integrations/*');

          const influxQueryRoutes = createInfluxQueryRoutes({ authService: this.authService });
          this.httpServer.getApp().use('/api/v1', influxQueryRoutes);
          logger.info('✅ Influx query proxy registered at POST /api/v1/influx/query');
        } else {
          logger.warn('⚠️ Dashboard/integration/query routes skipped — AuthService not initialized');
        }
      } else {
        logger.warn('⚠️ Dashboard/integration/query routes skipped — AUTH_SECRET not configured');
      }
    } else {
      logger.info('⏭️ Dashboard/integration/query routes skipped — InfluxDB unavailable');
    }

    await this.httpServer.start();
    
    logger.info('✅ HTTP server initialized');
  }

  private initializeOtaServices(): void {
    if (!this.config.ota?.enabled) return;

    this.firmwareStorageService = createFirmwareStorageService(this.config.ota);
    initOtaSigningState(this.config.ota.signingConfirmed);
    if (this.config.ota.signingPublicKeyPem) {
      initOtaSigningKeyAudit(this.config.ota.signingPublicKeyPem, 'env');
    } else if (this.config.ota.signingPublicKeyPath) {
      try {
        const pem = fs.readFileSync(this.config.ota.signingPublicKeyPath, 'utf8');
        initOtaSigningKeyAudit(pem, 'file');
      } catch {
        /* key file audit best-effort */
      }
    }
    void this.firmwareStorageService
      .verifyBucketAccess()
      .catch((err: unknown) => {
        logger.error('[OTA] OCI bucket access check failed', {
          bucket: this.config.ota?.oci.bucket,
          namespace: this.config.ota?.oci.namespace,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    this.otaPublicBaseUrl = resolveOtaPublicBaseUrl({
      otaPublicBaseUrl: process.env.OTA_PUBLIC_BASE_URL,
      publicAppUrl: process.env.PUBLIC_APP_URL,
      httpHost: this.config.http.host,
      httpPort: this.config.http.port
    });

    this.otaRedisState = new OtaRedisState(
      () => this.getRedisClientOrNull(),
      this.config.redis.keyPrefix || 'proof-mqtt:'
    );
    this.otaCommandPublisher = new OtaCommandPublisher(
      this.mqttClient,
      this.config.mqtt.topicRoot,
      this.config.ota.broadcastTopic,
      this.otaRedisState,
      this.config.ota
    );
    this.otaService = new OtaService(
      this.config.ota,
      this.firmwareStorageService,
      this.otaPublicBaseUrl,
      this.otaCommandPublisher,
      this.otaRedisState
    );
    this.otaEventHandler = new OtaEventHandler(this.otaService, this.otaCommandPublisher);

    const otaReleaseLog = createOtaReleaseLog();
    void otaReleaseLog.initialize().catch((err: unknown) => {
      logger.warn('[OTA] Release log initialization failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err)
      });
    });

    logger.info('✅ OTA services initialized', {
      mqttDownloadMode: 'presigned',
      httpDownloadMode: this.config.ota.downloadMode,
      publicBaseUrl: this.otaPublicBaseUrl,
      bucket: this.config.ota.oci.bucket,
      namespace: this.config.ota.oci.namespace,
      delivery: 'server-driven'
    });
    if (this.config.ota.downloadMode === 'proxy') {
      logger.warn(
        '[OTA] OTA_DOWNLOAD_MODE=proxy enables GET /api/v1/ota/download only — requires mTLS-capable HTTP edge (not Railway public URL). MQTT always uses OCI presigned PAR.'
      );
    }
  }

  private async initializeStatsPublisher(): Promise<void> {
    logger.info('📊 Initializing stats publisher...');
    
    this.statsPublisher = new StatsPublisher(
      this.mqttClient,
      this.deviceService,
      60 * 1000, // Publish every minute to /instagram, /gmb, /promotion
      this.caService,
      this.config.provisioning.requireMtlsForRegistration
    );
    
    await this.statsPublisher.start();

    if (this.httpServer) {
      const routeDeps = {
        statsPublisher: this.statsPublisher,
        topicRoot: this.config.mqtt.topicRoot
      };
      this.httpServer.getApp().use('/api/v1', createConnectionsRoutes(routeDeps));
      logger.info('✅ Connections routes registered at POST /api/v1/connections/validate');
    }

    logger.info('✅ Stats publisher initialized - publishing every 60s to /instagram, /gmb, /promotion');
  }

  private initializeConnectRefreshCoordinator(): void {
    const gmbConnectPull = new GmbConnectPull(
      this.mqttClient,
      this.config.webhooks.mqttPublishEnabled,
      this.config.webhooks
    );
    this.connectRefreshCoordinator = new ConnectRefreshCoordinator({
      mqttClient: this.mqttClient,
      redisService: this.redisService ?? null,
      instagramPoller: this.instagramPoller ?? null,
      instagramPriorityTtlMs: this.config.instagramPolling?.priorityTtlMs ?? 300_000,
      gmbConnectPull,
      statsPublisher: this.statsPublisher
    });
    logger.info('✅ Connect refresh coordinator initialized (/active → debounced screen pull)');
  }

  private initializeKeepAlive(): void {
    if (process.env.ENABLE_SELF_KEEPALIVE !== 'true') {
      return;
    }

    const keepAliveInterval = 10 * 60 * 1000;

    this.keepAliveTimer = setInterval(() => {
      const url = `http://127.0.0.1:${this.config.http.port}/health`;
      fetch(url)
        .then((res) => {
          logger.debug('Keep-alive ping sent', {
            status: res.status,
            interval: '10min'
          });
        })
        .catch((err: unknown) => {
          logger.debug('Keep-alive ping failed (normal if external monitoring exists)', {
            error: err instanceof Error ? err.message : String(err)
          });
        });
    }, keepAliveInterval);

    logger.info('Keep-alive enabled', { interval: '10 minutes' });
  }

  async stop(): Promise<void> {
    logger.info('🛑 Stopping MQTT Publisher Lite...');
    
    try {
      // Stop keep-alive timer
      if (this.keepAliveTimer) {
        clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = null;
      }

      // Stop Instagram poller
      if (this.instagramPoller) {
        this.instagramPoller.stop();
      }

      // TEMP STIMULATE — remove after testing
      if (this.stimulateService) {
        await this.stimulateService.stop();
      }

      // Stop stats publisher
      if (this.statsPublisher) {
        await this.statsPublisher.stop();
      }

      // Close HTTP server
      if (this.httpServer) {
        await this.httpServer.stop();
      }

      // Disconnect MQTT client
      if (this.mqttClient) {
        await this.mqttClient.disconnect();
      }

      // Flush Influx disk WAL (HTTP batches) and close write API
      if (this.influxService) {
        await this.influxService.close();
        this.influxService = undefined;
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
