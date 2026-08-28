import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import {
  loadWebhookConfig,
  validateWebhookConfig,
  type WebhookConfig
} from './webhookConfig';
import { configureLogger } from '../utils/logger';
import { envBool, envInt, envString, assertTestOtaAllowed } from './envHelpers';
import {
  loadInfluxDbConfig,
  normalizeInfluxDbUrl,
  type InfluxDBConfig
} from './influxConfig';
import {
  loadInstagramPollingConfig,
  loadInstagramServerlessConfig,
  type InstagramPollingConfig,
  type InstagramServerlessConfig
} from './instagramPollingConfig';
import {
  loadMqttConfig,
  normalizeMqttPemFromEnv,
  setMqttTlsClientPem,
  type MqttConfig
} from './mqttConfig';
import { loadLoyaltyConfig, loyaltySecretRequired, type LoyaltyConfig } from './loyaltyConfig';
import {
  DEFAULT_PROVISIONING_CA_STORAGE_PATH,
  getProvisioningRootCaCertFromEnv,
  getProvisioningRootCaKeyFromEnv,
  loadProvisioningConfig,
  writeProvisioningRootCaFromEnv,
  type ProvisioningConfig
} from './provisioningConfig';
import {
  OTA_CHECK_RATE_LIMIT_SEC,
  OTA_MQTT_PUSH_CONCURRENCY,
  OTA_OCI_BUCKET,
  OTA_OCI_NAMESPACE,
  OTA_OCI_REGION,
  OTA_PRESIGNED_TTL_SEC,
  OTA_ROLLBACK_FAILURE_THRESHOLD,
  OTA_STAGE_ABORT_FAILURE_RATE,
  OTA_STAGE_ABORT_MIN_SAMPLE,
  OTA_STAGE_MIN_HOURS,
  otaOciParBaseUrl,
  resolveOtaDownloadMode,
  type OtaDownloadMode
} from './otaDefaults';

export type { WebhookConfig };

// Load environment variables
dotenv.config();

export interface HttpConfig {
  port: number;
  host: string;
  requestLogging: boolean;
  healthChecksEnabled: boolean;
}

export interface StorageConfig {
  dataDir: string;
  sessionTTL: number;
  deviceCleanupInterval: number;
}

export interface MongoDBConfig {
  uri: string;
  dbName: string;
  /** Mongoose maxPoolSize (default 10). Env: MONGODB_MAX_POOL_SIZE */
  maxPoolSize: number;
  /** Mongoose minPoolSize (default 2). Env: MONGODB_MIN_POOL_SIZE */
  minPoolSize: number;
}

export interface RedisConfig {
  enabled: boolean;
  /** Preferred single connection string (e.g. Upstash): rediss://default:...@host:6379 */
  url?: string;
  db?: number;         // Redis database number (default 0)
  keyPrefix?: string;  // Key prefix for namespacing
}

export interface AppEnvConfig {
  env: string;
  logLevel: string;
  /** Influx startup health probe retries (default 3). Env: INFLUXDB_HEALTH_RETRIES */
  maxRetries: number;
  /** Reserved for metrics collectors; default 10000 ms. Env: METRICS_INTERVAL_MS */
  metricsIntervalMs: number;
  /** Reserved for retention policy hints; default 30 days. Env: METRICS_RETENTION_DAYS */
  metricsRetentionDays: number;
}

/** Runtime feature toggles (all default on). Override only to disable behavior. */
export interface AppFeaturesConfig {
  autoStart: boolean;
  errorReporting: boolean;
  gracefulShutdown: boolean;
  healthChecks: boolean;
  metricsCollection: boolean;
  requestLogging: boolean;
}

export interface AuthConfig {
  secret: string;  // AUTH_SECRET from environment
}

/**
 * POST target for Instagram metrics (serverless worker, e.g. Vercel). Main server forwards device batches here.
 */
export type { OtaDownloadMode };

export interface OtaOciCredentials {
  tenancyId: string;
  userId: string;
  fingerprint: string;
  privateKey: string;
}

export interface OtaOciConfig {
  namespace: string;
  bucket: string;
  region: string;
  parBaseUrl: string;
  /** Env-based API key auth (required when OTA_ENABLED=true). */
  credentials?: OtaOciCredentials;
}

export interface OtaConfig {
  enabled: boolean;
  oci: OtaOciConfig;
  presignedUrlTtlSec: number;
  /** Ed25519 public key PEM (env or file). */
  signingPublicKeyPem?: string;
  /** @deprecated Prefer OTA_ED25519_PUBLIC_KEY_BASE64 */
  signingPublicKeyPath?: string;
  /** When false, promote is blocked until OTA_SIGNING_CONFIRMED=true (firmware team). */
  signingConfirmed: boolean;
  broadcastTopic: string;
  downloadMode: OtaDownloadMode;
  checkRateLimitSec: number;
  rollbackFailureThreshold: number;
  /** Bearer secret for POST /api/webhooks/ota-release and ota-rollout-advance (high privilege). */
  releaseWebhookSecret?: string;
  stageAbortMinSample: number;
  stageAbortFailureRate: number;
  stageMinHours: number;
  mqttPushConcurrency: number;
}

export { loadLoyaltyConfig, loyaltySecretRequired, type LoyaltyConfig } from './loyaltyConfig';

export {
  normalizeMqttPemFromEnv,
  setMqttTlsClientPem,
  normalizeInfluxDbUrl,
  DEFAULT_PROVISIONING_CA_STORAGE_PATH
};
export type {
  MqttConfig,
  ProvisioningConfig,
  InstagramServerlessConfig,
  InstagramPollingConfig,
  InfluxDBConfig
};

export interface AppConfig {
  mqtt: MqttConfig;
  http: HttpConfig;
  storage: StorageConfig;
  provisioning: ProvisioningConfig;
  mongodb: MongoDBConfig;
  redis: RedisConfig;
  auth: AuthConfig;
  app: AppEnvConfig;
  features: AppFeaturesConfig;
  webhooks: WebhookConfig;
  influxdb: InfluxDBConfig;
  instagramPolling?: InstagramPollingConfig;
  /**
   * Optional serverless worker URL. When set, all poller fetches POST here.
   * When unset, the poller still runs (requires Redis) and calls Instagram Graph from this process.
   */
  instagramServerless?: InstagramServerlessConfig;
  ota?: OtaConfig;
  loyalty: LoyaltyConfig;
}

function normalizePemFromEnv(raw: string): string {
  return raw.trim().replace(/\\n/g, '\n');
}

function loadOciCredentialsFromEnv(): OtaOciCredentials | undefined {
  const tenancyId = process.env.OCI_TENANCY_OCID?.trim();
  const userId = process.env.OCI_USER_OCID?.trim();
  const fingerprint = process.env.OCI_FINGERPRINT?.trim();

  let privateKey = process.env.OCI_API_PRIVATE_KEY?.trim();
  if (!privateKey && process.env.OCI_API_PRIVATE_KEY_BASE64?.trim()) {
    try {
      privateKey = Buffer.from(process.env.OCI_API_PRIVATE_KEY_BASE64.trim(), 'base64').toString('utf8');
    } catch {
      privateKey = undefined;
    }
  }
  if (!privateKey && process.env.OCI_PRIVATE_KEY?.trim()) {
    privateKey = process.env.OCI_PRIVATE_KEY.trim();
  }

  if (tenancyId && userId && fingerprint && privateKey) {
    return {
      tenancyId,
      userId,
      fingerprint,
      privateKey: normalizePemFromEnv(privateKey)
    };
  }
  return undefined;
}

function loadOtaSigningPublicKeyPem(): string | undefined {
  const inline = process.env.OTA_ED25519_PUBLIC_KEY_PEM?.trim();
  if (inline) return normalizePemFromEnv(inline);

  const b64 = process.env.OTA_ED25519_PUBLIC_KEY_BASE64?.trim();
  if (b64) {
    try {
      return normalizePemFromEnv(Buffer.from(b64, 'base64').toString('utf8'));
    } catch {
      return undefined;
    }
  }

  const keyPath = process.env.OTA_ED25519_PUBLIC_KEY_PATH?.trim();
  if (keyPath && fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath, 'utf8');
  }
  return undefined;
}

export function loadConfig(): AppConfig {
  const dataDir = process.env.DATA_DIR || './data';

  const provisioningCaDirFromEnv = writeProvisioningRootCaFromEnv();
  const mqtt = loadMqttConfig();
  const instagramServerless = loadInstagramServerlessConfig();
  const instagramPolling = loadInstagramPollingConfig();
  const influxdb = loadInfluxDbConfig(dataDir);

  const redisUrl = process.env.REDIS_URL?.trim();



  const metricsCollectionEnabled = envBool('ENABLE_METRICS_COLLECTION', true);
  const influxHealthRetries = envInt('INFLUXDB_HEALTH_RETRIES', 3, ['MAX_RETRIES']);
  process.env.INFLUXDB_HEALTH_RETRIES = String(influxHealthRetries);

  const config: AppConfig = {
    mqtt,
    http: {
      port: parseInt(process.env.PORT || process.env.HTTP_PORT || '3002', 10),
      host: process.env.HTTP_HOST || '0.0.0.0',
      requestLogging: envBool('ENABLE_REQUEST_LOGGING', true),
      healthChecksEnabled: envBool('ENABLE_HEALTH_CHECKS', true)
    },
    storage: {
      dataDir,
      sessionTTL: parseInt(process.env.SESSION_TTL || '86400', 10),
      deviceCleanupInterval: parseInt(process.env.DEVICE_CLEANUP_INTERVAL || '3600', 10)
    },
    provisioning: loadProvisioningConfig(dataDir, provisioningCaDirFromEnv),
    mongodb: {
      uri: process.env.MONGODB_URI || process.env.MONGO_URI || '',
      dbName: process.env.MONGODB_DB_NAME || 'statsmqtt',
      maxPoolSize: envInt('MONGODB_MAX_POOL_SIZE', 10, ['CONNECTION_POOL_MAX']),
      minPoolSize: envInt('MONGODB_MIN_POOL_SIZE', 2, ['CONNECTION_POOL_MIN'])
    },
    redis: {
      enabled: Boolean(redisUrl),
      url: redisUrl,
      db: parseInt(process.env.REDIS_DB || '0', 10),
      keyPrefix: process.env.REDIS_KEY_PREFIX || 'proof-mqtt:',
    },
    auth: {
      secret: process.env.AUTH_SECRET || ''
    },
    app: {
      env: envString('NODE_ENV', 'development'),
      logLevel: envString('LOG_LEVEL', 'info'),
      maxRetries: influxHealthRetries,
      metricsIntervalMs: envInt('METRICS_INTERVAL_MS', 10_000, ['METRICS_INTERVAL']),
      metricsRetentionDays: envInt('METRICS_RETENTION_DAYS', 30)
    },
    features: {
      autoStart: envBool('ENABLE_AUTO_START', true),
      errorReporting: envBool('ENABLE_ERROR_REPORTING', true),
      gracefulShutdown: envBool('ENABLE_GRACEFUL_SHUTDOWN', true),
      healthChecks: envBool('ENABLE_HEALTH_CHECKS', true),
      metricsCollection: metricsCollectionEnabled,
      requestLogging: envBool('ENABLE_REQUEST_LOGGING', true)
    },
    webhooks: loadWebhookConfig(),
    instagramServerless,
    influxdb,
    instagramPolling,
    loyalty: loadLoyaltyConfig()
  };

  const topicRoot = config.mqtt.topicRoot;
  const otaEnabled = process.env.OTA_ENABLED === 'true';
  if (otaEnabled) {
    const ociNamespace = envString('OTA_OCI_NAMESPACE', OTA_OCI_NAMESPACE);
    const ociBucket = envString('OTA_OCI_BUCKET', OTA_OCI_BUCKET);
    const ociRegion = envString('OTA_OCI_REGION', OTA_OCI_REGION);
    const parOverride = process.env.OTA_OCI_PAR_BASE_URL?.trim();
    const ociCredentials = loadOciCredentialsFromEnv();
    const signingPublicKeyPem = loadOtaSigningPublicKeyPem();

    config.ota = {
      enabled: true,
      oci: {
        namespace: ociNamespace,
        bucket: ociBucket,
        region: ociRegion,
        parBaseUrl: parOverride || otaOciParBaseUrl(ociNamespace, ociRegion),
        credentials: ociCredentials
      },
      presignedUrlTtlSec: envInt('OTA_PRESIGNED_TTL_SEC', OTA_PRESIGNED_TTL_SEC),
      signingPublicKeyPem,
      signingPublicKeyPath: process.env.OTA_ED25519_PUBLIC_KEY_PATH?.trim() || undefined,
      signingConfirmed:
        process.env.OTA_SIGNING_CONFIRMED === 'true' || process.env.OTA_SIGNING_CONFIRMED === '1',
      broadcastTopic:
        process.env.OTA_BROADCAST_TOPIC?.trim() || `${topicRoot}/broadcast/cmd`,
      downloadMode: resolveOtaDownloadMode(process.env.OTA_DOWNLOAD_MODE),
      checkRateLimitSec: envInt('OTA_CHECK_RATE_LIMIT_SEC', OTA_CHECK_RATE_LIMIT_SEC),
      rollbackFailureThreshold: envInt(
        'OTA_ROLLBACK_FAILURE_THRESHOLD',
        OTA_ROLLBACK_FAILURE_THRESHOLD
      ),
      releaseWebhookSecret: process.env.OTA_RELEASE_WEBHOOK_SECRET?.trim() || undefined,
      stageAbortMinSample: envInt('OTA_STAGE_ABORT_MIN_SAMPLE', OTA_STAGE_ABORT_MIN_SAMPLE),
      stageAbortFailureRate: (() => {
        const raw = process.env.OTA_STAGE_ABORT_FAILURE_RATE?.trim();
        if (raw == null || raw === '') return OTA_STAGE_ABORT_FAILURE_RATE;
        const n = Number(raw);
        return Number.isFinite(n) ? n : OTA_STAGE_ABORT_FAILURE_RATE;
      })(),
      stageMinHours: envInt('OTA_STAGE_MIN_HOURS', OTA_STAGE_MIN_HOURS),
      mqttPushConcurrency: envInt('OTA_MQTT_PUSH_CONCURRENCY', OTA_MQTT_PUSH_CONCURRENCY)
    };
  }

  logger.info('Configuration loaded', {
    mqtt: {
      broker: config.mqtt.broker,
      port: config.mqtt.port,
      topicPrefix: config.mqtt.topicPrefix,
      authX509Only: config.mqtt.authX509Only === true,
      mqttConnectUser: config.mqtt.authX509Only ? 'none (X.509 only)' : config.mqtt.username ? 'set' : 'none'
    },
    http: {
      port: config.http.port
    },
    provisioning: {
      enabled: config.provisioning.enabled,
      tokenTTL: config.provisioning.tokenTTL,
      caStoragePath: config.provisioning.caStoragePath
    },
    mongodb: {
      uri: config.mongodb.uri ? '***' : 'NOT SET',
      dbName: config.mongodb.dbName
    },
    redis: {
      host: config.redis.url ? '(via REDIS_URL)' : 'not set',
      port: config.redis.url ? '(via REDIS_URL)' : 'not set',
      keyPrefix: config.redis.keyPrefix
    },
    influxdb: {
      url: config.influxdb.url,
      org: config.influxdb.org,
      bucket: config.influxdb.bucket,
      complianceBucket: config.influxdb.complianceBucket,
      diskQueue: config.influxdb.diskQueueEnabled,
      diskQueueSync: config.influxdb.diskQueueSyncOnAppend,
      diskQueuePath: config.influxdb.diskQueueEnabled ? config.influxdb.diskQueuePath : undefined,
      token: config.influxdb.token ? '(set)' : 'MISSING'
    },
    env: config.app.env,
    logLevel: config.app.logLevel
  });

  configureLogger(config.app.logLevel);

  return config;
}

export function validateConfig(config: AppConfig): void {
  assertTestOtaAllowed();

  if (!config.mqtt.broker) {
    throw new Error('MQTT broker is required');
  }
  if (config.mqtt.port < 1 || config.mqtt.port > 65535) {
    throw new Error('Invalid MQTT port');
  }
  if (config.http.port < 1 || config.http.port > 65535) {
    throw new Error('Invalid HTTP port');
  }
  if (config.provisioning.enabled && !config.provisioning.jwtSecret) {
    throw new Error(
      config.app.env === 'production'
        ? 'JWT_SECRET or PROVISIONING_JWT_SECRET is required in production when provisioning is enabled.'
        : 'JWT secret is required when provisioning is enabled'
    );
  }
  if (config.provisioning.enabled && !config.auth.secret) {
    throw new Error('AUTH_SECRET is required when provisioning is enabled. Set AUTH_SECRET environment variable.');
  }
  if (config.provisioning.enabled) {
    const certPem = getProvisioningRootCaCertFromEnv();
    const keyPem = getProvisioningRootCaKeyFromEnv();
    const keyFromEnvRequested = Boolean(process.env.MQTT_TLS_CA_KEY_BASE64?.trim());
    if (keyFromEnvRequested && !keyPem) {
      throw new Error(
        'Provisioning Root CA: MQTT_TLS_CA_KEY_BASE64 is set but the private key PEM is missing or invalid after base64 decode.'
      );
    }
    if (keyFromEnvRequested && !certPem) {
      throw new Error(
        'Provisioning Root CA: set MQTT_TLS_CA_BASE64 (Root CA certificate, base64 PEM) together with MQTT_TLS_CA_KEY_BASE64.'
      );
    }
  }
  if (!config.mongodb.uri) {
    throw new Error('MongoDB URI is REQUIRED. Set MONGODB_URI environment variable.');
  }

  if (process.env.ENABLE_METRICS_COLLECTION === 'false') {
    throw new Error('ENABLE_METRICS_COLLECTION=false is not allowed — InfluxDB audit is required.');
  }
  if (!config.influxdb.token) {
    throw new Error('INFLUXDB_TOKEN is REQUIRED. Set INFLUXDB_TOKEN environment variable.');
  }
  if (!config.influxdb.org?.trim()) {
    throw new Error('INFLUXDB_ORG is REQUIRED.');
  }
  if (!config.influxdb.bucket?.trim()) {
    throw new Error('INFLUXDB_BUCKET is REQUIRED.');
  }
  if (!config.influxdb.complianceBucket?.trim()) {
    throw new Error('INFLUXDB_COMPLIANCE_BUCKET is REQUIRED.');
  }

  if (config.ota?.enabled) {
    if (config.ota.presignedUrlTtlSec < 60) {
      throw new Error('OTA_PRESIGNED_TTL_SEC must be at least 60');
    }
    const hasOciAuth = !!config.ota.oci.credentials;
    if (!hasOciAuth) {
      throw new Error(
        'OTA_ENABLED requires OCI_API_PRIVATE_KEY_BASE64, OCI_TENANCY_OCID, OCI_USER_OCID, OCI_FINGERPRINT'
      );
    }
    if (!config.ota.signingPublicKeyPem) {
      logger.warn(
        '[OTA] OTA_ED25519_PUBLIC_KEY_BASE64 not set — webhook/finalize signature verification will fail until configured'
      );
    }
    if (!config.ota.releaseWebhookSecret) {
      if (config.app.env === 'production') {
        throw new Error(
          'OTA_RELEASE_WEBHOOK_SECRET is required in production when OTA is enabled.'
        );
      }
      logger.warn(
        '[OTA] OTA_RELEASE_WEBHOOK_SECRET not set — CI webhook ingest disabled until configured'
      );
    }
  }

  if (config.mqtt.authX509Only) {
    const tls = config.mqtt.tls;
    if (!tls?.enabled) {
      throw new Error(
        'mTLS-only MQTT: set MQTT_TLS_ENABLED=true and provide CA + client cert/key via MQTT_TLS_*_BASE64 or MQTT_TLS_*_PEM (env only, in-memory — not broker/certs or data/.mqtt-tls/).'
      );
    }
    const hasCa = !!(tls.caPem && tls.caPem.includes('-----BEGIN'));
    const hasCert = !!(tls.clientCertPem && tls.clientCertPem.includes('-----BEGIN'));
    const hasKey = !!(tls.clientKeyPem && tls.clientKeyPem.includes('-----BEGIN'));
    if (!hasCa) {
      throw new Error(
        'mTLS-only MQTT: set MQTT_TLS_CA_PEM / MQTT_TLS_CA_CERT or MQTT_TLS_CA_BASE64 (broker trust CA PEM).'
      );
    }
    if (!hasCert || !hasKey) {
      throw new Error(
        'mTLS-only MQTT: set MQTT_TLS_CLIENT_CERT_PEM + MQTT_TLS_CLIENT_KEY_PEM or MQTT_TLS_CLIENT_CERT_BASE64 + MQTT_TLS_CLIENT_KEY_BASE64.'
      );
    }
  }
  if (config.app.env === 'production' && !config.redis.url) {
    throw new Error(
      'REDIS_URL is required in production. Set REDIS_URL to your Upstash Redis TLS endpoint (rediss://...@...upstash.io:6379).'
    );
  }
  if (!config.redis.url) {
    logger.warn('REDIS_URL not set. Redis features disabled; provisioning tokens will fall back to in-memory storage.');
    config.redis.enabled = false;
  } else {
    if (!config.redis.url.startsWith('rediss://')) {
      throw new Error('REDIS_URL must start with rediss:// (TLS) when connecting to Upstash Redis.');
    }
    if (!config.redis.url.includes('upstash.io')) {
      logger.warn('REDIS_URL does not include upstash.io — are you sure you want non-Upstash Redis?', {
        redisHostHint: (() => {
          try {
            return new URL(config.redis.url!).hostname;
          } catch {
            return 'unknown';
          }
        })()
      });
    }
  }

  validateWebhookConfig(config.webhooks, config.app.env);

  if (loyaltySecretRequired(config.app.env) && !config.loyalty.spinSecret) {
    throw new Error(
      'LOYALTY_SPIN_SECRET is required in staging/production (X-Loyalty-Key on POST /loyalty/spin).'
    );
  }

  logger.info('Configuration validated successfully');
}

// Example onboarding curl (replace AUTH_TOKEN with your admin JWT):
// curl -s -X POST "http://localhost:3002/api/v1/onboarding" \
//   -H "Authorization: Bearer <AUTH_TOKEN>" \
//   -H "Content-Type: application/json" \
//   -d '{"device_id":"unified-server-dev"}'