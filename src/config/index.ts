import dotenv from 'dotenv';
import { logger } from '../utils/logger';

// Load environment variables
dotenv.config();

export interface MqttConfig {
  broker: string;
  port: number;
  clientId: string;
  username?: string;
  password?: string;
  topicPrefix: string;
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
}

export interface MongoDBConfig {
  uri: string;
  dbName: string;
}

export interface RedisConfig {
  enabled: boolean;
  url?: string;        // Full Redis URL (alternative to individual params)
  // Supports both redis:// and rediss:// (TLS) URLs
  // Example: rediss://username:password@host:port (Redis Cloud)
  username?: string;   // Redis username (default: 'default')
  password?: string;   // Redis password
  host?: string;       // Redis host
  port?: number;       // Redis port
  db?: number;         // Redis database number
  keyPrefix?: string;  // Key prefix for namespacing
  tls?: boolean;       // Enable TLS for host/port connections (default: false)
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
      topicPrefix: process.env.MQTT_TOPIC_PREFIX || ''  // No prefix for statsnapp topics
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
      tokenTTL: parseInt(process.env.PROVISIONING_TOKEN_TTL || '300'),  // 5 minutes
      jwtSecret: process.env.JWT_SECRET || process.env.PROVISIONING_JWT_SECRET || 'mqtt-publisher-lite-secret-key-change-in-production',
      caStoragePath: process.env.CA_STORAGE_PATH || `${dataDir}/ca`,
      rootCAValidityYears: parseInt(process.env.ROOT_CA_VALIDITY_YEARS || '10'),
      deviceCertValidityDays: parseInt(process.env.DEVICE_CERT_VALIDITY_DAYS || '90'),
      certificateDbPath: process.env.CERTIFICATE_DB_PATH || `${dataDir}/certificates.db`
    },
    mongodb: {
      uri: process.env.MONGODB_URI || process.env.MONGO_URI || '',
      dbName: process.env.MONGODB_DB_NAME || 'statsmqtt'
    },
    redis: {
      enabled: process.env.REDIS_ENABLED !== 'false',  // Enabled by default
      url: process.env.REDIS_URL || process.env.REDIS_URI,  // Full Redis URL (optional)
      // Supports both redis:// and rediss:// (TLS) URLs
      // Example: rediss://username:password@host:port (Redis Cloud)
      username: process.env.REDIS_USERNAME || 'default',
      password: process.env.REDIS_PASSWORD,
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined,
      db: parseInt(process.env.REDIS_DB || '0'),
      keyPrefix: process.env.REDIS_KEY_PREFIX || 'mqtt-lite:',
      tls: process.env.REDIS_TLS === 'true' || process.env.REDIS_TLS === '1'  // Enable TLS for host/port connections
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
      enabled: config.redis.enabled,
      url: config.redis.url ? '***' : undefined,
      username: config.redis.username,
      host: config.redis.host || 'not set',
      port: config.redis.port || 'not set',
      keyPrefix: config.redis.keyPrefix
    },
    env: config.app.env
  });

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
  if (config.redis.enabled && !config.redis.url && (!config.redis.host || !config.redis.port)) {
    logger.warn('Redis enabled but no connection details provided. Provisioning tokens will not be persistent.');
    logger.warn('Set REDIS_URL (cloud) or REDIS_HOST + REDIS_PORT (self-hosted) environment variables.');
    logger.warn('To disable Redis, set REDIS_ENABLED=false');
    // Auto-disable Redis if not configured to prevent connection attempts
    config.redis.enabled = false;
  }

  logger.info('Configuration validated successfully');
}

