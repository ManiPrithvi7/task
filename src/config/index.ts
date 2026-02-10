import dotenv from 'dotenv';
import { logger } from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';

// Load environment variables
dotenv.config();

export interface MqttConfig {
  broker: string;
  port: number;
  clientId: string;
  username?: string;
  password?: string;
  /** Optional prefix prepended to all topics (e.g. '' or 'proof.mqtt'). */
  topicPrefix: string;
  /** Topic root for device topics (e.g. proof.mqtt). Used for proof.mqtt/device_123/active, instagram, gmb, pos. */
  topicRoot: string;
  /** TLS / mTLS configuration for connecting to MQTT broker (optional) */
  tls?: {
    enabled?: boolean;
    caPath?: string;         // Path to CA cert (PEM)
    clientCertPath?: string; // Path to client cert (PEM) for mTLS (optional)
    clientKeyPath?: string;  // Path to client private key (PEM) for mTLS (optional)
    rejectUnauthorized?: boolean;
  };
}

export interface HttpConfig {
  port: number;
  host: string;
}

export interface StorageConfig {
  dataDir: string;
  sessionTTL: number;
  deviceCleanupInterval: number;
}

export interface ProvisioningConfig {
  enabled: boolean;
  tokenTTL: number;
  jwtSecret: string;
  caStoragePath: string;
  rootCAValidityYears: number;
  deviceCertValidityDays: number;
  certificateDbPath: string;
  /** Require device to have an active (provisioned) certificate before accepting registration (mTLS alignment). */
  requireMtlsForRegistration: boolean;
}

export interface MongoDBConfig {
  uri: string;
  dbName: string;
}

export interface RedisConfig {
  enabled: boolean;
  host?: string;       // Redis host (REDIS_HOST)
  port?: number;       // Redis port (REDIS_PORT)
  password?: string;   // Redis password (REDIS_PASSWORD)
  db?: number;         // Redis database number (default 0)
  keyPrefix?: string;  // Key prefix for namespacing
  tls?: boolean;       // Enable TLS for Redis Cloud (REDIS_TLS=true)
}

export interface AppEnvConfig {
  env: string;
  logLevel: string;
}

export interface AuthConfig {
  secret: string;  // AUTH_SECRET from environment
}

export interface AppConfig {
  mqtt: MqttConfig;
  http: HttpConfig;
  storage: StorageConfig;
  provisioning: ProvisioningConfig;
  mongodb: MongoDBConfig;
  redis: RedisConfig;
  auth: AuthConfig;
  app: AppEnvConfig;
}

export function loadConfig(): AppConfig {
  const dataDir = process.env.DATA_DIR || './data';

  const config: AppConfig = {
    mqtt: {
      broker: process.env.MQTT_BROKER || 'broker.emqx.io',
      port: parseInt(process.env.MQTT_PORT || '1883'),
      clientId: process.env.MQTT_CLIENT_ID || `firmware-test-1234`,
      username: process.env.MQTT_USERNAME || undefined,
      password: process.env.MQTT_PASSWORD || undefined,
      topicPrefix: process.env.MQTT_TOPIC_PREFIX || '',
      topicRoot: process.env.MQTT_TOPIC_ROOT || 'proof.mqtt',
      tls: {
        enabled: process.env.MQTT_TLS_ENABLED === 'true' || process.env.MQTT_TLS === 'true',
        caPath: process.env.MQTT_TLS_CA_PATH || process.env.MQTT_CA_PATH || undefined,
        clientCertPath: process.env.MQTT_TLS_CLIENT_CERT_PATH || process.env.MQTT_CLIENT_CERT_PATH || undefined,
        clientKeyPath: process.env.MQTT_TLS_CLIENT_KEY_PATH || process.env.MQTT_CLIENT_KEY_PATH || undefined,
        rejectUnauthorized: process.env.MQTT_TLS_REJECT_UNAUTHORIZED !== 'false'
      }
    },
    http: {
      port: parseInt(process.env.PORT || process.env.HTTP_PORT || '3002'),  // Render uses PORT
      host: process.env.HTTP_HOST || '0.0.0.0'
    },
    storage: {
      dataDir,
      sessionTTL: parseInt(process.env.SESSION_TTL || '86400'),
      deviceCleanupInterval: parseInt(process.env.DEVICE_CLEANUP_INTERVAL || '3600')
    },
    provisioning: {
      enabled: process.env.PROVISIONING_ENABLED !== 'false',  // Enabled by default
      tokenTTL: parseInt(process.env.PROVISIONING_TOKEN_TTL || '6000'),  // 1 hour
      jwtSecret: process.env.JWT_SECRET || process.env.PROVISIONING_JWT_SECRET || 'mqtt-publisher-lite-secret-key-change-in-production',
      caStoragePath: process.env.CA_STORAGE_PATH || `${dataDir}/ca`,
      rootCAValidityYears: parseInt(process.env.ROOT_CA_VALIDITY_YEARS || '10'),
      deviceCertValidityDays: parseInt(process.env.DEVICE_CERT_VALIDITY_DAYS || '90'),
      certificateDbPath: process.env.CERTIFICATE_DB_PATH || `${dataDir}/certificates.db`,
      requireMtlsForRegistration: process.env.REQUIRE_MTLS_FOR_REGISTRATION !== 'false'  // Default true: only provisioned devices can register
    },
    mongodb: {
      uri: process.env.MONGODB_URI || process.env.MONGO_URI || '',
      dbName: process.env.MONGODB_DB_NAME || 'statsmqtt'
    },
    redis: {
      enabled: process.env.REDIS_ENABLED !== 'false',
      host: process.env.REDIS_HOST?.trim(),
      port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : undefined,
      password: process.env.REDIS_PASSWORD,
      db: parseInt(process.env.REDIS_DB || '0', 10),
      keyPrefix: process.env.REDIS_KEY_PREFIX || 'mqtt-lite:',
      tls: process.env.REDIS_TLS === 'true' || process.env.REDIS_TLS === '1'
    },
    auth: {
      secret: process.env.AUTH_SECRET || ''
    },
    app: {
      env: process.env.NODE_ENV || 'development',
      logLevel: process.env.LOG_LEVEL || 'info'
    }
  };

  logger.info('Configuration loaded', {
    mqtt: {
      broker: config.mqtt.broker,
      port: config.mqtt.port,
      topicPrefix: config.mqtt.topicPrefix
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
      host: config.redis.host || 'not set',
      port: config.redis.port ?? 'not set',
      keyPrefix: config.redis.keyPrefix
    },
    env: config.app.env
  });
  /**
   * Helper: write PEM file from base64 env var into a desired path if file missing.
   * - envVarName: name of env var containing base64-encoded PEM
   * - filePath: where to write the decoded PEM
   * - mode: file mode (e.g. 0o644 for cert, 0o600 for key)
   */
  const writePemFromBase64 = (envVarName: string | undefined, filePath: string | undefined, mode: number) => {
    if (!envVarName || !filePath) return;
    const b64 = process.env[envVarName];
    if (!b64) return;
    const resolved = path.resolve(filePath);
    try {
      if (fs.existsSync(resolved)) {
        logger.debug('PEM file already exists, skipping write', { path: resolved });
        return;
      }
      // Ensure directory exists
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      const buf = Buffer.from(b64, 'base64');
      fs.writeFileSync(resolved, buf, { mode });
      logger.info('Wrote PEM from env to filesystem', { envVarName, path: resolved });
    } catch (err: any) {
      logger.warn('Failed to write PEM from env', { envVarName, path: resolved, error: err?.message ?? String(err) });
    }
  };

  // If TLS config present, allow writing CA / client cert / key from base64 env vars.
  const tlsCfg = config.mqtt.tls;
  if (tlsCfg) {
    // CA
    writePemFromBase64('MQTT_TLS_CA_BASE64', tlsCfg.caPath, 0o644);
    // Client cert
    writePemFromBase64('MQTT_TLS_CLIENT_CERT_BASE64', tlsCfg.clientCertPath, 0o644);
    // Client key (private) — secure mode
    writePemFromBase64('MQTT_TLS_CLIENT_KEY_BASE64', tlsCfg.clientKeyPath, 0o600);
  }

  return config;
}

export function validateConfig(config: AppConfig): void {
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
    throw new Error('JWT secret is required when provisioning is enabled');
  }
  if (config.provisioning.enabled && !config.auth.secret) {
    throw new Error('AUTH_SECRET is required when provisioning is enabled. Set AUTH_SECRET environment variable.');
  }
  if (!config.mongodb.uri) {
    throw new Error('MongoDB URI is REQUIRED. Set MONGODB_URI environment variable.');
  }
  // Redis: host + port required when enabled (password optional for no-auth Redis).
  if (config.redis.enabled && (!config.redis.host || config.redis.port === undefined)) {
    logger.warn('Redis enabled but REDIS_HOST or REDIS_PORT not set. Provisioning tokens will use in-memory storage.');
    logger.warn('Set REDIS_HOST and REDIS_PORT (and REDIS_PASSWORD if required). To disable Redis, set REDIS_ENABLED=false');
    config.redis.enabled = false;
  }

  logger.info('Configuration validated successfully');
}

