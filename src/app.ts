import { logger } from './utils/logger';
import { loadConfig, validateConfig, AppConfig, setMqttTlsClientPem } from './config';
import type { BootstrapHost } from './bootstrap/bootstrapHost';
import {
  extractDeviceIdFromTopic,
  cacheActiveDevice,
  handleDeviceRegistration as handleDeviceRegistrationBootstrap,
  handleDeviceLWT as handleDeviceLWTBootstrap,
  handleDeviceStatus as handleDeviceStatusBootstrap,
  handleDeviceOtaTelemetry as handleDeviceOtaTelemetryBootstrap
} from './bootstrap/deviceRegistrationHandler';
import { initializePhase2 as runPhase2Bootstrap } from './bootstrap/serviceInitializer';
import { initializeOtaServices as initializeOtaServicesBootstrap } from './bootstrap/otaServiceBootstrap';
import {
  deliverOtaOnRegistration as deliverOtaOnRegistrationCoord,
  executeOtaRegistrationDelivery,
  type OtaRegistrationCoordinatorDeps
} from './bootstrap/otaRegistrationCoordinator';
import { HttpServer } from './servers/httpServer';
import { MqttClientManager } from './servers/mqttClient';
import { StatsPublisher } from './services/statsPublisher';
import { ConnectRefreshCoordinator } from './services/connectRefreshCoordinator';
import {
  DeferredDeviceWorkQueue,
  isDeferredWorkRearmEnabled,
  resolveOtaRegistrationDeferConcurrency
} from './services/deferredDeviceWork';
import {
  flushMessageBuffer,
  routeMqttMessage,
  type MqttIngressHandlers,
  type MqttIngressRouterState
} from './services/mqttIngressRouter';
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
import { InfluxService } from './services/influxService';
import { AuditService } from './services/auditService';
import { TransparencyLog } from './services/transparencyLog';
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
import { getIgDeviceRuntimeCache, markDeviceHashInactive, migrateDeviceKeysToHash } from './services/igDeviceRuntimeCache';
import { getRedisSyncService } from './services/redisSync';
import { SessionService } from './services/sessionService';
import { Device, type IDevice } from './models/Device';
import { DeviceCertificate, DeviceCertificateStatus } from './models/DeviceCertificate';
import { Social, Provider as SocialProvider } from './models/Social';
import { createFirmwareStorageService } from './services/firmwareStorageService';
import {
  OtaService,
  OtaCommandPublisher,
  OtaEventHandler,
  OtaRedisState
} from './services/otaService';
import { type RolloutSchedulerHandle } from './jobs/rolloutScheduler';
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
import { ensureDeviceProvisioned as checkDeviceProvisioned } from './services/deviceProvisioningGate';
import { LoyaltyService } from './services/loyaltyService';

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
  private otaRolloutScheduler?: RolloutSchedulerHandle;

  // Active device cache (Redis-backed)
  private activeDeviceCache!: ActiveDeviceCache;
  private loyaltyService?: LoyaltyService;

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

  private bootstrapHost(): BootstrapHost {
    return this as unknown as BootstrapHost;
  }

  private otaRegistrationDeps(): OtaRegistrationCoordinatorDeps {
    return {
      config: this.config,
      otaService: this.otaService,
      otaCommandPublisher: this.otaCommandPublisher,
      otaPublicBaseUrl: this.otaPublicBaseUrl,
      deferredWork: this.deferredWork,
      isServicesReady: this.isServicesReady,
      processDeferredWork: () => this.processDeferredWork()
    };
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
      multi.sAdd(REDIS_KEYS.activeDevices, deviceId);
      multi.expire(REDIS_KEYS.activeDevices, 604800);
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
    if (client) {
      try {
        const multi = client.multi();
        multi.sRem(REDIS_KEYS.activeDevices, deviceId);
        await multi.exec();
        // Sync screen-critical counts before clearing local state
        const runtime = getIgDeviceRuntimeCache();
        const followers = runtime.getFollowers(deviceId);
        const gmb = runtime.getGmbReviewCount(deviceId);
        const updates: Record<string, string> = { status: 'inactive' };
        if (followers !== undefined) updates.ig_follower_count = String(followers);
        if (gmb !== undefined) updates.gmb_review_count = String(gmb);
        const key = REDIS_KEYS.deviceHash(deviceId);
        await client.hSet(key, updates);
        await client.expire(key, 7 * 24 * 3600);
      } catch (err: unknown) {
        logger.debug('Redis: failed to remove device keys', {
          deviceId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
    await markDeviceHashInactive(deviceId);
  }

  /** Latest Instagram row for a Mongo User id (`Social` collection, name `Social` in Atlas). */
  private async loadLatestInstagramSocialForUser(
    userIdStr: string
  ): Promise<{ socialAccountId: string; accessToken: string; tokenExp: string } | null> {
    if (!mongoose.Types.ObjectId.isValid(userIdStr)) return null;
    try {
      const uid = new mongoose.Types.ObjectId(userIdStr);
      const ig = await Social.findOne({
        businessId: uid,
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
      await this.subscribeLoyaltyAck();

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
    await runPhase2Bootstrap(this.bootstrapHost());
  }

  private buildMqttIngressHandlers(): MqttIngressHandlers {
    const host = this.bootstrapHost();
    return {
      onActive: (topic, message) =>
        handleDeviceRegistrationBootstrap(host, topic, message as Record<string, unknown>),
      onLwt: (topic, message) =>
        handleDeviceLWTBootstrap(host, topic, message as Record<string, unknown>),
      onStatus: (topic, message) =>
        handleDeviceStatusBootstrap(host, topic, message as Record<string, unknown>),
      onOtaTelemetry: (topic, message) =>
        handleDeviceOtaTelemetryBootstrap(host, topic, message as Record<string, unknown>),
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
      extractDeviceId: (topic) => extractDeviceIdFromTopic(host, topic)
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

    const result = await this.deferredWork.processAll(
      async (item) => {
        if (item.type === 'connect_refresh') {
          if (!coordinator) {
            // Fail (not silent success) so processAll can retry once / count failed.
            logger.warn('[DEFERRED_WORK] Connect refresh coordinator not ready', {
              deviceId: item.deviceId
            });
            throw new Error('CONNECT_REFRESH_NOT_READY');
          }
          try {
            await coordinator.refresh(item.deviceId);
          } catch (err: unknown) {
            logger.error('[DEFERRED_WORK] connect_refresh failed', {
              deviceId: item.deviceId,
              error: err instanceof Error ? err.message : String(err)
            });
            throw err;
          }
          return;
        }

        if (item.type === 'ota_registration') {
          await executeOtaRegistrationDelivery(this.otaRegistrationDeps(), item.deviceId, item.currentVersion);
        }
      },
      { otaRegistrationConcurrency: resolveOtaRegistrationDeferConcurrency() }
    );

    // A concurrent call while a drain is in flight is a no-op: the in-flight
    // drain owns the re-arm. Logging/re-arming here would loop unboundedly.
    if (!result.drained) return;

    logger.info('[DEFERRED_WORK] Drain complete', {
      pending: result.pendingBefore,
      processed: result.processed,
      failed: result.failed,
      skippedStale: result.skippedStale,
      requeued: result.requeued,
      pendingAfter: result.pendingAfter,
      rearmed: result.rearmed
    });

    // Rollback: DEFERRED_WORK_REARM=false disables second drain after enqueue-during-flight.
    if (isDeferredWorkRearmEnabled() && result.rearmed && this.deferredWork.pendingCount() > 0) {
      void this.processDeferredWork().catch((err: unknown) => {
        logger.error('[DEFERRED_WORK] Rearm drain failed', {
          error: err instanceof Error ? err.message : String(err)
        });
      });
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
      await restoreActiveDevicesFromRedis(client, (deviceId) =>
        cacheActiveDevice(this.bootstrapHost(), deviceId)
      );

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
      dataDir: this.config.storage.dataDir,
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
      const migrated = await migrateDeviceKeysToHash(this.redisService.getClient());
      logger.info('[DEVICE_HASH_MIGRATION] Startup sweep complete', { migrated });
      getRedisSyncService().start(this.redisService.getClient());
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

  /** Power-save: runtime cache + dirty device hash field (synced by RedisSync). */
  private async setDevicePowerSaveFlag(deviceId: string): Promise<void> {
    const runtime = getIgDeviceRuntimeCache();
    const state = runtime.get(deviceId);
    if (state?.powerSaveSet && state.powerSaveSetAt && Date.now() - state.powerSaveSetAt < 23 * 3600 * 1000) {
      return;
    }
    runtime.set(deviceId, { powerSave: true, powerSaveSet: true, powerSaveSetAt: Date.now() });
    runtime.markDirty(deviceId, 'power_save');
    logger.debug('[IG_POLL] power_save flag set for device', { deviceId });
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
      // On device active (PUBACK received) — update lastSeen only; active SET is connect-path only
      async (deviceId: string) => {
        logger.debug('✅ [LIFECYCLE:PUBACK_OK] Device confirmed message receipt', { deviceId });
        await this.activeDeviceCache.updateLastSeen(deviceId);
      }
    );
    
    await this.mqttClient.connect();

    this.loyaltyService = new LoyaltyService({
      mqtt: this.mqttClient,
      config: this.config.loyalty,
      topicRoot: this.config.mqtt.topicRoot
    });
    this.loyaltyService.start();

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
        void this.subscribeLoyaltyAck().catch((err: unknown) => {
          logger.error('MQTT loyalty ack re-subscribe failed', {
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

  private async subscribeLoyaltyAck(): Promise<void> {
    const topic = `${this.config.mqtt.topicRoot}/+/ack`;
    await this.mqttClient.subscribe(topic, (receivedTopic, payload) => {
      void this.onLoyaltyAck(receivedTopic, payload);
    });
    logger.info('Subscribed to loyalty ack topic', { topic });
  }

  private async onLoyaltyAck(topic: string, payload: Buffer): Promise<void> {
    if (!this.loyaltyService) return;
    try {
      const message = JSON.parse(payload.toString());
      await this.loyaltyService.handleAck(topic, message);
    } catch (err: unknown) {
      logger.warn('loyalty ack parse/handle failed', {
        topic,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private async ensureDeviceProvisioned(deviceId: string): Promise<boolean> {
    return checkDeviceProvisioned(deviceId, {
      provisioning: this.config.provisioning,
      caService: this.caService
    });
  }

  private async deliverOtaOnRegistration(deviceId: string, appVersion?: string): Promise<void> {
    await deliverOtaOnRegistrationCoord(this.otaRegistrationDeps(), deviceId, appVersion);
  }

  private initializeOtaServices(): void {
    initializeOtaServicesBootstrap(this.bootstrapHost());
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

      if (this.redisService?.isRedisConnected()) {
        getRedisSyncService().stop();
        await getRedisSyncService().flush(this.redisService.getClient());
      }

      // TEMP STIMULATE — remove after testing
      if (this.stimulateService) {
        await this.stimulateService.stop();
      }

      // Stop stats publisher
      if (this.statsPublisher) {
        await this.statsPublisher.stop();
      }

      if (this.loyaltyService) {
        this.loyaltyService.stop();
        this.loyaltyService = undefined;
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
