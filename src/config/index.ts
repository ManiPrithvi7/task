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
  /** Certificate Common Name (CN) prefix for devices (e.g. 'PROOF_') */
  cnPrefix: string;
  /** CN format: 'legacy' (PROOF-deviceId) or 'structured' (PROOF-ORDER-BATCH-DEVICE) — PKI #1 */
  cnFormat: 'legacy' | 'structured';
  /** Certificate profile for signing and validation */
  certProfile?: {
    validityDays: number;
    keyUsage: string[]; // e.g. ['digitalSignature','keyEncipherment']
    extendedKeyUsage: string[]; // e.g. ['clientAuth']
    requireSanDeviceId: boolean;
    minKeyBits: number;
  };
  /** PKI #2: Enable certificate chain validation (intermediate CA) */
  intermediateCAEnabled: boolean;
  /** PKI #3: Enable hash-chained audit logging */
  auditHashChainEnabled: boolean;
  /** PKI #3: Enable HSM signing of audit chain roots (Phase 2) */
  auditHsmSigningEnabled: boolean;
  /** PKI #4: Enforce KU/EKU at runtime (every device auth check) */
  enforceRuntimeKuEku: boolean;
  /** PKI #5: Days before expiry to start renewal window */
  certRenewalWindowDays: number;
  /** PKI #5: Days after expiry to accept cert with warning (grace period) */
  certGracePeriodDays: number;
  /** PKI #5: Minutes between emergency renewal attempts in grace period */
  certEmergencyRenewalInterval: number;
  /** PKI #6: CSR rate limits */
  csrRateLimits: {
    provisionedLimit: number;
    unprovisionedLimit: number;
    globalLimit: number;
    perIpLimit: number;
    windowSeconds: number;
  };
  /** PKI #7: Enable certificate transparency log (Merkle tree) */
  transparencyLogEnabled: boolean;
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

export interface InfluxDBConfig {
  enabled: boolean;
  url: string;
  token: string;
  org: string;
  bucket: string;
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
  influxdb: InfluxDBConfig;
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
      requireMtlsForRegistration: process.env.REQUIRE_MTLS_FOR_REGISTRATION !== 'false',  // Default true: only provisioned devices can register
      cnPrefix: process.env.CERT_CN_PREFIX || 'PROOF_',
      cnFormat: (process.env.CERT_CN_FORMAT === 'structured' ? 'structured' : 'legacy') as 'legacy' | 'structured',
      certProfile: {
        validityDays: parseInt(process.env.CERT_VALIDITY_DAYS || String(process.env.DEVICE_CERT_VALIDITY_DAYS || '90'), 10),
        keyUsage: (process.env.CERT_KEY_USAGE || 'digitalSignature,keyEncipherment').split(',').map(s => s.trim()).filter(Boolean),
        extendedKeyUsage: (process.env.CERT_EXTENDED_KEY_USAGE || 'clientAuth').split(',').map(s => s.trim()).filter(Boolean),
        requireSanDeviceId: process.env.CERT_SAN_REQUIRE_DEVICE_ID !== 'false',
        minKeyBits: parseInt(process.env.CERT_MIN_KEY_BITS || '2048', 10)
      },
      // PKI #2: Intermediate CA
      intermediateCAEnabled: process.env.INTERMEDIATE_CA_ENABLED === 'true',
      // PKI #3: Audit hash chain
      auditHashChainEnabled: process.env.AUDIT_HASH_CHAIN_ENABLED !== 'false',  // Default: true
      auditHsmSigningEnabled: process.env.AUDIT_HSM_SIGNING_ENABLED === 'true',
      // PKI #4: Runtime KU/EKU enforcement
      enforceRuntimeKuEku: process.env.ENFORCE_RUNTIME_KU_EKU !== 'false',  // Default: true
      // PKI #5: Grace period
      certRenewalWindowDays: parseInt(process.env.CERT_RENEWAL_WINDOW_DAYS || '45', 10),
      certGracePeriodDays: parseInt(process.env.CERT_GRACE_PERIOD_DAYS || '20', 10),
      certEmergencyRenewalInterval: parseInt(process.env.CERT_EMERGENCY_RENEWAL_INTERVAL || '5', 10),
      // PKI #6: CSR rate limits
      csrRateLimits: {
        provisionedLimit: parseInt(process.env.CSR_RATE_LIMIT_PROVISIONED || '10', 10),
        unprovisionedLimit: parseInt(process.env.CSR_RATE_LIMIT_UNPROVISIONED || '3', 10),
        globalLimit: parseInt(process.env.CSR_RATE_LIMIT_GLOBAL || '100', 10),
        perIpLimit: parseInt(process.env.CSR_RATE_LIMIT_PER_IP || '5', 10),
        windowSeconds: parseInt(process.env.CSR_RATE_LIMIT_WINDOW || '900', 10)
      },
      // PKI #7: Transparency log
      transparencyLogEnabled: process.env.TRANSPARENCY_LOG_ENABLED === 'true'
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
    influxdb: {
      enabled: process.env.INFLUXDB_ENABLED !== 'false',
      url: process.env.INFLUXDB_URL || `http://${process.env.INFLUXDB_HOST || 'localhost'}:${process.env.INFLUXDB_PORT || '8086'}`,
      token: process.env.INFLUXDB_TOKEN || 'statsmqtt-admin-token-2024',
      org: process.env.INFLUXDB_ORG || 'statsmqtt',
      bucket: process.env.INFLUXDB_BUCKET || 'metrics'
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
    influxdb: {
      enabled: config.influxdb.enabled,
      url: config.influxdb.url,
      org: config.influxdb.org,
      bucket: config.influxdb.bucket
    },
    env: config.app.env
  });
  /**
   * Helper: write PEM file from environment vars into a desired path if file missing.
   * Supports either a raw PEM env var (MQTT_TLS_*_PEM) or a base64-encoded env var (MQTT_TLS_*_BASE64).
   * - envB64Name: name of env var containing base64-encoded PEM
   * - envPemName: name of env var containing raw PEM
   * - filePath: where to write the decoded PEM
   * - mode: file mode (e.g. 0o644 for cert, 0o600 for key)
   */
  const writePemFromEnv = (envB64Name: string | undefined, envPemName: string | undefined, filePath: string | undefined, mode: number) => {
    if (!filePath) return;
    const resolved = path.resolve(filePath);
    try {
      if (fs.existsSync(resolved)) {
        logger.debug('PEM file already exists, skipping write', { path: resolved });
        return;
      }
      // Prefer raw PEM env over base64
      const rawPem = envPemName ? process.env[envPemName] : undefined;
      const b64 = envB64Name ? process.env[envB64Name] : undefined;
      if (!rawPem && !b64) {
        // Nothing to write
        return;
      }
      // Ensure directory exists
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      if (rawPem) {
        fs.writeFileSync(resolved, rawPem, { encoding: 'utf8', mode });
        logger.info('Wrote PEM from raw env to filesystem', { envPemName, path: resolved });
        return;
      }
      // Base64 fallback
      const buf = Buffer.from(b64 as string, 'base64');
      fs.writeFileSync(resolved, buf, { mode });
      logger.info('Wrote PEM from base64 env to filesystem', { envB64Name, path: resolved });
    } catch (err: any) {
      logger.warn('Failed to write PEM from env', { envB64Name, envPemName, path: resolved, error: err?.message ?? String(err) });
    }
  };

  // If TLS config present, ensure TLS paths exist (use sensible defaults under dataDir)
  const tlsCfg = config.mqtt.tls;
  if (tlsCfg) {
    // Provide defaults if paths not set
    // IMPORTANT: broker CA must NOT collide with the provisioning Root CA filename (root-ca.crt / root-ca.key)
    // because CAService.initialize() will overwrite root-ca.crt if root-ca.key is missing.
    // Use 'broker-ca.crt' as the default so the two CAs stay separate.
    const defaultCa = path.join(dataDir, 'ca', 'broker-ca.crt');
    const defaultClientCert = path.join(dataDir, 'ca', 'client.crt');
    const defaultClientKey = path.join(dataDir, 'ca', 'client.key');

    tlsCfg.caPath = tlsCfg.caPath || process.env.MQTT_TLS_CA_PATH || defaultCa;
    tlsCfg.clientCertPath = tlsCfg.clientCertPath || process.env.MQTT_TLS_CLIENT_CERT_PATH || defaultClientCert;
    tlsCfg.clientKeyPath = tlsCfg.clientKeyPath || process.env.MQTT_TLS_CLIENT_KEY_PATH || defaultClientKey;

    // Try to write from env (raw PEM preferred, base64 fallback)
    writePemFromEnv('MQTT_TLS_CA_BASE64', 'MQTT_TLS_CA_PEM', tlsCfg.caPath, 0o644);
    writePemFromEnv('MQTT_TLS_CLIENT_CERT_BASE64', 'MQTT_TLS_CLIENT_CERT_PEM', tlsCfg.clientCertPath, 0o644);
    writePemFromEnv('MQTT_TLS_CLIENT_KEY_BASE64', 'MQTT_TLS_CLIENT_KEY_PEM', tlsCfg.clientKeyPath, 0o600);

    // Resolve absolute paths for downstream modules
    try {
      tlsCfg.caPath = path.resolve(tlsCfg.caPath);
      tlsCfg.clientCertPath = path.resolve(tlsCfg.clientCertPath);
      tlsCfg.clientKeyPath = path.resolve(tlsCfg.clientKeyPath);
    } catch (err) {
      logger.debug('Failed to resolve TLS paths', { error: err instanceof Error ? err.message : String(err) });
    }
    // Guard: avoid accidentally using the Root CA key as the client key.
    // If clientKeyPath points to a file named root-ca.key, replace it with a sensible client key default.
    try {
      const caKeyCandidate = path.join(path.dirname(tlsCfg.caPath), 'root-ca.key');
      if (tlsCfg.clientKeyPath && path.resolve(tlsCfg.clientKeyPath) === path.resolve(caKeyCandidate)) {
        const fallbackClientKey = path.resolve(path.join(dataDir, 'ca', 'client.key'));
        logger.warn('Client key path pointed to root CA key; switching to fallback client key path to avoid PEM confusion', {
          old: tlsCfg.clientKeyPath,
          new: fallbackClientKey
        });
        tlsCfg.clientKeyPath = fallbackClientKey;
      }
    } catch (err) {
      // ignore resolution errors here
    }
  }

  return config;
}

export function validateConfig(config: AppConfig): void {
  console.log("mongo", config.mongodb.uri)
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

// # Replace AUTH_TOKEN with your admin JWT and PUBLISHER_URL with your server URL
// PROV=$(curl -s -X POST "http://localhost:3002/api/v1/onboarding" \
//   -H "Authorization: Bearer eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2Q0JDLUhTNTEyIiwia2lkIjoic2JSbkJueXR2VDBzN1VkTXE2VGhMUmxhU2ljcU1reHFERi1FRGRoV2NJNldTaUtwT0tORkY2eFllMm1YaGwtbFVXVlh2VXJKakFienpLY0hDRTlOYXcifQ..vCOb0KfIkeYbSpYvm2zmmw.Ne7vrHllldHCfCXo0n5o6zlLPS7dsAuGV2NjQWtX0kioTDdfwIclJBp9vkObjiWfZq3zIfWbXl9edB4TgHneAxlASo5QglL_JrnEyqgnz8eLIHpQsrHM5fkBeLGLf3hyHe_0HQrElwqSF61EE4SWX2-8bq0jgWEkElcmyYHgo32V2SjEUHxA3ParFhDz0Bx9ICouCzxvXTSsui61XcC3CAIMJGN4WYxZu5Ug157hmkPVsIhuFYuSDt4dQwkiotF0cjLi_F9A0L7u3gsPbUInlpJ2dQyqtz2cJ3XY6ceJMC60adFqECMjnro7LMH62_Kifm6o-hc6KtuALuc_7hqPGzp_Sxyn6pLMgSbDMOne7F5Cr446ujPWByGVaaWq_1v48GAraozlfxRfjKkm2CMhj6-O4dEFzMhXrUE3R-r9AfE25vd_DROo3zY50h_lpD6P.DeVYKY5KqNgHXULXboDy-5UTsQQLm6a7xiD5U30pgjE" \
//   -H "Content-Type: application/json" \
//   -d '{"device_id":"unified-server-dev"}' | jq -r '.provisioning_token')

// echo "Provisioning token: $PROV"