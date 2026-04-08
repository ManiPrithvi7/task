import dotenv from 'dotenv';
import { logger } from '../utils/logger';

// Load environment variables
dotenv.config();

/** Normalize PEM pasted in env with literal `\n` (e.g. Railway). */
export function normalizeMqttPemFromEnv(raw: string): string {
  return raw.trim().replace(/\\n/g, '\n');
}

function looksLikePem(value: string): boolean {
  return value.includes('-----BEGIN');
}

function decodeBase64ToUtf8(b64: string | undefined): string | undefined {
  if (!b64?.trim()) return undefined;
  try {
    return Buffer.from(b64.trim(), 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

/** First env whose value looks like a PEM block; normalizes escaped newlines. */
function firstPemEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const v = process.env[name];
    if (v?.trim() && looksLikePem(v)) {
      return normalizeMqttPemFromEnv(v);
    }
  }
  return undefined;
}

export interface MqttConfig {
  broker: string;
  port: number;
  clientId: string;
  /**
   * Derived: true when MQTT_USERNAME and MQTT_PASSWORD are both unset or empty (after trim).
   * Then CONNECT uses no user/pass and the broker should authenticate via client TLS certificate.
   */
  authX509Only?: boolean;
  username?: string;
  password?: string;
  /** Optional prefix prepended to all topics (e.g. '' or 'proof.mqtt'). */
  topicPrefix: string;
  /** Topic root for device topics (e.g. proof.mqtt). Used for proof.mqtt/device_123/active, instagram, gmb, pos. */
  topicRoot: string;
  /** TLS / mTLS configuration for connecting to MQTT broker (optional) */
  tls?: {
    enabled?: boolean;
    /** Broker CA + client cert/key: env PEM or *_BASE64 only (no file paths). */
    caPem?: string;
    clientCertPem?: string;
    clientKeyPem?: string;
    rejectUnauthorized?: boolean;
    /** TLS SNI / cert hostname (e.g. broker cert CN when MQTT_BROKER is a TCP proxy hostname). */
    servername?: string;
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
  /** Certificate Common Name (CN) prefix for devices (e.g. 'PROOF_') */
  cnPrefix: string;
  /** Certificate profile for signing and validation */
  certProfile?: {
    validityDays: number;
    keyUsage: string[]; // e.g. ['digitalSignature','keyEncipherment']
    extendedKeyUsage: string[]; // e.g. ['clientAuth']
    requireSanDeviceId: boolean;
    minKeyBits: number;
  };
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

  const userTrim = process.env.MQTT_USERNAME?.trim();
  const passTrim = process.env.MQTT_PASSWORD?.trim();
  const mtlsOnlyEnv =
    process.env.MQTT_MTLS_ONLY === 'true' ||
    process.env.MQTT_MTLS_ONLY === '1' ||
    process.env.MQTT_AUTH_X509_ONLY === 'true';
  const authX509Only = mtlsOnlyEnv || (!userTrim && !passTrim);

  // Inline PEM (env) — same idea as NANOMQ_TLS_* on the broker; supports literal \n
  const caPemInline =
    firstPemEnv('MQTT_TLS_CA_PEM', 'MQTT_TLS_CA_CERT') ||
    decodeBase64ToUtf8(process.env.MQTT_TLS_CA_BASE64);
  const mqttTlsCaRaw = process.env.MQTT_TLS_CA?.trim();
  const caPemResolved =
    caPemInline ||
    (mqttTlsCaRaw && looksLikePem(mqttTlsCaRaw) ? normalizeMqttPemFromEnv(mqttTlsCaRaw) : undefined);
  if (mqttTlsCaRaw && !looksLikePem(mqttTlsCaRaw)) {
    logger.warn('MQTT_TLS_CA is set but is not PEM text; path-based CA is not supported. Use MQTT_TLS_CA_BASE64 or MQTT_TLS_CA_PEM.');
  }

  const clientCertPemInline =
    firstPemEnv('MQTT_TLS_CLIENT_CERT_PEM') ||
    decodeBase64ToUtf8(process.env.MQTT_TLS_CLIENT_CERT_BASE64);
  const mqttTlsClientCertRaw = process.env.MQTT_TLS_CLIENT_CERT?.trim();
  const clientCertPemResolved =
    clientCertPemInline ||
    (mqttTlsClientCertRaw && looksLikePem(mqttTlsClientCertRaw)
      ? normalizeMqttPemFromEnv(mqttTlsClientCertRaw)
      : undefined);
  if (mqttTlsClientCertRaw && !looksLikePem(mqttTlsClientCertRaw)) {
    logger.warn('MQTT_TLS_CLIENT_CERT is set but is not PEM text; path-based client cert is not supported. Use *_BASE64 or *_PEM.');
  }

  const clientKeyPemInline =
    firstPemEnv('MQTT_TLS_CLIENT_KEY_PEM') ||
    decodeBase64ToUtf8(process.env.MQTT_TLS_CLIENT_KEY_BASE64);
  const mqttTlsClientKeyRaw = process.env.MQTT_TLS_CLIENT_KEY?.trim();
  const clientKeyPemResolved =
    clientKeyPemInline ||
    (mqttTlsClientKeyRaw && looksLikePem(mqttTlsClientKeyRaw)
      ? normalizeMqttPemFromEnv(mqttTlsClientKeyRaw)
      : undefined);
  if (mqttTlsClientKeyRaw && !looksLikePem(mqttTlsClientKeyRaw)) {
    logger.warn('MQTT_TLS_CLIENT_KEY is set but is not PEM text; path-based client key is not supported. Use *_BASE64 or *_PEM.');
  }

  const tlsExplicitOn =
    process.env.MQTT_TLS_ENABLED === 'true' || process.env.MQTT_TLS === 'true';
  const tlsEnabled =
    tlsExplicitOn ||
    !!caPemResolved ||
    !!clientCertPemResolved ||
    !!clientKeyPemResolved ||
    !!process.env.MQTT_TLS_CA_BASE64 ||
    !!process.env.MQTT_TLS_CLIENT_CERT_BASE64 ||
    !!process.env.MQTT_TLS_CLIENT_KEY_BASE64;

  const config: AppConfig = {
    mqtt: {
      broker: process.env.MQTT_BROKER || 'broker.emqx.io',
      port: parseInt(process.env.MQTT_PORT || '1883'),
      clientId: process.env.MQTT_CLIENT_ID || `firmware-test-1234`,
      authX509Only,
      username: mtlsOnlyEnv ? undefined : userTrim || undefined,
      password: mtlsOnlyEnv ? undefined : passTrim || undefined,
      topicPrefix: process.env.MQTT_TOPIC_PREFIX || '',
      topicRoot: process.env.MQTT_TOPIC_ROOT || 'proof.mqtt',
      tls: {
        enabled: tlsEnabled,
        caPem: caPemResolved,
        clientCertPem: clientCertPemResolved,
        clientKeyPem: clientKeyPemResolved,
        rejectUnauthorized: process.env.MQTT_TLS_REJECT_UNAUTHORIZED !== 'false',
        servername: process.env.MQTT_TLS_SERVERNAME?.trim() || undefined
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
      requireMtlsForRegistration: process.env.REQUIRE_MTLS_FOR_REGISTRATION !== 'false',  // Default true: only provisioned devices can register
      cnPrefix: process.env.CERT_CN_PREFIX || 'PROOF_'
      ,
      certProfile: {
        validityDays: parseInt(process.env.CERT_VALIDITY_DAYS || String(process.env.DEVICE_CERT_VALIDITY_DAYS || '90'), 10),
        keyUsage: (process.env.CERT_KEY_USAGE || 'digitalSignature,keyEncipherment').split(',').map(s => s.trim()).filter(Boolean),
        extendedKeyUsage: (process.env.CERT_EXTENDED_KEY_USAGE || 'clientAuth').split(',').map(s => s.trim()).filter(Boolean),
        requireSanDeviceId: process.env.CERT_SAN_REQUIRE_DEVICE_ID !== 'false',
        minKeyBits: parseInt(process.env.CERT_MIN_KEY_BITS || '2048', 10)
      }
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
      host: config.redis.host || 'not set',
      port: config.redis.port ?? 'not set',
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

  if (config.mqtt.authX509Only) {
    const tls = config.mqtt.tls;
    if (!tls?.enabled) {
      throw new Error(
        'mTLS-only MQTT: set MQTT_TLS_ENABLED=true and provide CA + client cert/key via MQTT_TLS_*_BASE64 or MQTT_TLS_*_PEM (no file paths).'
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
  // Redis: host + port required when enabled (password optional for no-auth Redis).
  if (config.redis.enabled && (!config.redis.host || config.redis.port === undefined)) {
    logger.warn('Redis enabled but REDIS_HOST or REDIS_PORT not set. Provisioning tokens will use in-memory storage.');
    logger.warn('Set REDIS_HOST and REDIS_PORT (and REDIS_PASSWORD if required). To disable Redis, set REDIS_ENABLED=false');
    config.redis.enabled = false;
  }

  logger.info('Configuration validated successfully');
}

// # Replace AUTH_TOKEN with your admin JWT and PUBLISHER_URL with your server URL
// PROV=$(curl -s -X POST "http://localhost:3002/api/v1/onboarding" \
//   -H "Authorization: Bearer eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2Q0JDLUhTNTEyIiwia2lkIjoic2JSbkJueXR2VDBzN1VkTXE2VGhMUmxhU2ljcU1reHFERi1FRGRoV2NJNldTaUtwT0tORkY2eFllMm1YaGwtbFVXVlh2VXJKakFienpLY0hDRTlOYXcifQ..vCOb0KfIkeYbSpYvm2zmmw.Ne7vrHllldHCfCXo0n5o6zlLPS7dsAuGV2NjQWtX0kioTDdfwIclJBp9vkObjiWfZq3zIfWbXl9edB4TgHneAxlASo5QglL_JrnEyqgnz8eLIHpQsrHM5fkBeLGLf3hyHe_0HQrElwqSF61EE4SWX2-8bq0jgWEkElcmyYHgo32V2SjEUHxA3ParFhDz0Bx9ICouCzxvXTSsui61XcC3CAIMJGN4WYxZu5Ug157hmkPVsIhuFYuSDt4dQwkiotF0cjLi_F9A0L7u3gsPbUInlpJ2dQyqtz2cJ3XY6ceJMC60adFqECMjnro7LMH62_Kifm6o-hc6KtuALuc_7hqPGzp_Sxyn6pLMgSbDMOne7F5Cr446ujPWByGVaaWq_1v48GAraozlfxRfjKkm2CMhj6-O4dEFzMhXrUE3R-r9AfE25vd_DROo3zY50h_lpD6P.DeVYKY5KqNgHXULXboDy-5UTsQQLm6a7xiD5U30pgjE" \
//   -H "Content-Type: application/json" \
//   -d '{"device_id":"unified-server-dev"}' | jq -r '.provisioning_token')

// echo "Provisioning token: $PROV"