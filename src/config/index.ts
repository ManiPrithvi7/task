import dotenv from 'dotenv';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
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

function looksLikeCertificatePem(value: string): boolean {
  return value.includes('-----BEGIN CERTIFICATE-----');
}

function looksLikePrivateKeyPem(value: string): boolean {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(value);
}

/**
 * Provisioning Root CA certificate PEM — base64 only, same as broker-trust CA: `MQTT_TLS_CA_BASE64`.
 * Written to disk by `writeProvisioningRootCaFromEnv` for CAService; not used for validation when only MQTT mTLS is needed without an env signing key.
 */
function getProvisioningRootCaCertFromEnv(): string | undefined {
  const fromB64 = decodeBase64ToUtf8(process.env.MQTT_TLS_CA_BASE64);
  const certCandidate = fromB64 ? normalizeMqttPemFromEnv(fromB64) : undefined;
  if (certCandidate && looksLikeCertificatePem(certCandidate)) return certCandidate;
  return undefined;
}

/**
 * Provisioning Root CA private key PEM — base64 only: `MQTT_TLS_CA_KEY_BASE64`.
 * Required only when you want the app to sign CSRs using a Root CA key from env (paired with `MQTT_TLS_CA_BASE64`).
 */
function getProvisioningRootCaKeyFromEnv(): string | undefined {
  const fromB64 = decodeBase64ToUtf8(process.env.MQTT_TLS_CA_KEY_BASE64);
  const keyCandidate = fromB64 ? normalizeMqttPemFromEnv(fromB64) : undefined;
  if (keyCandidate && looksLikePrivateKeyPem(keyCandidate)) return keyCandidate;
  return undefined;
}

/** Default Root CA directory (env decode + auto-generated CA). Override with `CA_STORAGE_PATH` or `PROVISIONING_CA_DIR` (e.g. in Docker use `/data/provisioning-ca`). */
export const DEFAULT_PROVISIONING_CA_STORAGE_PATH = path.resolve(process.cwd(), 'src', 'certs');

/** Runtime directory for MQTT TLS PEMs (written from env each process start; not for committing). */
const MQTT_TLS_RUNTIME_SUB = '.mqtt-tls';

export function getMqttTlsRuntimeDir(dataDir: string): string {
  return path.join(path.resolve(dataDir), MQTT_TLS_RUNTIME_SUB);
}

/** MQTT TLS: env-only (BASE64 or *_PEM). No MQTT_TLS_CA / MQTT_TLS_CLIENT_* generic PEM, no loading pre-existing files. */
function resolveMqttTlsPemFromEnv(): {
  caPem?: string;
  clientCertPem?: string;
  clientKeyPem?: string;
} {
  const caPem =
    firstPemEnv('MQTT_TLS_CA_PEM', 'MQTT_TLS_CA_CERT') ||
    decodeBase64ToUtf8(process.env.MQTT_TLS_CA_BASE64);
  const clientCertPem =
    firstPemEnv('MQTT_TLS_CLIENT_CERT_PEM') ||
    decodeBase64ToUtf8(process.env.MQTT_TLS_CLIENT_CERT_BASE64);
  const clientKeyPem =
    firstPemEnv('MQTT_TLS_CLIENT_KEY_PEM') ||
    decodeBase64ToUtf8(process.env.MQTT_TLS_CLIENT_KEY_BASE64);
  return {
    caPem: caPem && looksLikeCertificatePem(caPem) ? caPem : undefined,
    clientCertPem: clientCertPem && looksLikeCertificatePem(clientCertPem) ? clientCertPem : undefined,
    clientKeyPem: clientKeyPem && looksLikePrivateKeyPem(clientKeyPem) ? clientKeyPem : undefined
  };
}

/**
 * Write MQTT TLS PEMs from env to dataDir/.mqtt-tls/ and read them back (single source for this run).
 * Does not read stale files if env is empty.
 */
function writeAndReadMqttTlsRuntime(dataDir: string): {
  caPem?: string;
  clientCertPem?: string;
  clientKeyPem?: string;
} {
  const resolved = resolveMqttTlsPemFromEnv();
  const { caPem, clientCertPem, clientKeyPem } = resolved;
  if (!caPem && !clientCertPem && !clientKeyPem) {
    return {};
  }

  const dir = getMqttTlsRuntimeDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  if (caPem) {
    const p = path.join(dir, 'ca.pem');
    fs.writeFileSync(p, caPem.endsWith('\n') ? caPem : `${caPem}\n`, { encoding: 'utf8', mode: 0o644 });
  }
  if (clientCertPem) {
    const p = path.join(dir, 'client.crt');
    fs.writeFileSync(p, clientCertPem.endsWith('\n') ? clientCertPem : `${clientCertPem}\n`, {
      encoding: 'utf8',
      mode: 0o644
    });
  }
  if (clientKeyPem) {
    const p = path.join(dir, 'client.key');
    fs.writeFileSync(p, clientKeyPem.endsWith('\n') ? clientKeyPem : `${clientKeyPem}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
  }

  const out: { caPem?: string; clientCertPem?: string; clientKeyPem?: string } = {};
  if (caPem) out.caPem = fs.readFileSync(path.join(dir, 'ca.pem'), 'utf8');
  if (clientCertPem) out.clientCertPem = fs.readFileSync(path.join(dir, 'client.crt'), 'utf8');
  if (clientKeyPem) out.clientKeyPem = fs.readFileSync(path.join(dir, 'client.key'), 'utf8');
  logger.info('MQTT TLS credentials loaded from environment via runtime directory', { mqttTlsRuntimeDir: dir });
  return out;
}

/** After CREATE_MQTT_CLIENT_CERT writes client.crt/key under .mqtt-tls/, refresh in-memory TLS for the MQTT client. */
export function reloadMqttTlsClientPemFromRuntime(config: AppConfig): void {
  const tls = config.mqtt.tls;
  if (!tls) return;
  const dir = getMqttTlsRuntimeDir(config.storage.dataDir);
  const certPath = path.join(dir, 'client.crt');
  const keyPath = path.join(dir, 'client.key');
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return;
  tls.clientCertPem = fs.readFileSync(certPath, 'utf8');
  tls.clientKeyPem = fs.readFileSync(keyPath, 'utf8');
  tls.enabled = true;
}

/**
 * Decode provisioning Root CA from env and write root-ca.crt / root-ca.key so CAService
 * loads the same material from disk (storagePath + fixed filenames).
 * Returns the directory used, or undefined so `caStoragePath` falls back to `CA_STORAGE_PATH` / {@link DEFAULT_PROVISIONING_CA_STORAGE_PATH}.
 */
function sha256HexPrefix(pemUtf8: string, hexChars = 16): string {
  return crypto.createHash('sha256').update(pemUtf8, 'utf8').digest('hex').slice(0, hexChars);
}

function describePrivateKeyPemKind(pem: string): 'PKCS#1 RSA' | 'PKCS#8' | 'EC' | 'unknown' {
  if (pem.includes('BEGIN RSA PRIVATE KEY')) return 'PKCS#1 RSA';
  if (pem.includes('BEGIN PRIVATE KEY')) return 'PKCS#8';
  if (pem.includes('BEGIN EC PRIVATE KEY')) return 'EC';
  return 'unknown';
}

function writeProvisioningRootCaFromEnv(): string | undefined {
  const caB64 = process.env.MQTT_TLS_CA_BASE64?.trim() ?? '';
  const keyB64 = process.env.MQTT_TLS_CA_KEY_BASE64?.trim() ?? '';

  logger.info('Provisioning Root CA: env probe (lengths only, values not logged)', {
    source: 'MQTT_TLS_CA_BASE64 + MQTT_TLS_CA_KEY_BASE64',
    MQTT_TLS_CA_BASE64_present: caB64.length > 0,
    MQTT_TLS_CA_BASE64_length: caB64.length,
    MQTT_TLS_CA_KEY_BASE64_present: keyB64.length > 0,
    MQTT_TLS_CA_KEY_BASE64_length: keyB64.length,
    PROVISIONING_CA_DIR: process.env.PROVISIONING_CA_DIR?.trim() || '(default)'
  });

  const certPem = getProvisioningRootCaCertFromEnv();
  const keyPem = getProvisioningRootCaKeyFromEnv();

  if (caB64.length > 0 && !certPem) {
    logger.warn(
      'Provisioning Root CA: MQTT_TLS_CA_BASE64 is set but decoded value is not a valid certificate PEM (check base64 and PEM format).'
    );
  }
  if (keyB64.length > 0 && !keyPem) {
    logger.warn(
      'Provisioning Root CA: MQTT_TLS_CA_KEY_BASE64 is set but decoded value is not a recognized private key PEM (check base64 and PEM format).'
    );
  }

  if (!certPem || !keyPem) {
    if (caB64.length > 0 || keyB64.length > 0) {
      logger.info('Provisioning Root CA: skipping write from env until both cert and key decode successfully', {
        certDecoded: !!certPem,
        keyDecoded: !!keyPem
      });
    }
    return undefined;
  }

  logger.info('Provisioning Root CA: read PEM from environment (decoded)', {
    cert_pem_bytes: Buffer.byteLength(certPem, 'utf8'),
    cert_sha256_prefix: sha256HexPrefix(certPem),
    key_pem_bytes: Buffer.byteLength(keyPem, 'utf8'),
    key_kind: describePrivateKeyPemKind(keyPem)
  });

  const dirRaw = process.env.PROVISIONING_CA_DIR?.trim();
  const dir = dirRaw
    ? path.isAbsolute(dirRaw)
      ? dirRaw
      : path.resolve(process.cwd(), dirRaw)
    : DEFAULT_PROVISIONING_CA_STORAGE_PATH;

  fs.mkdirSync(dir, { recursive: true });
  const certPath = path.join(dir, 'root-ca.crt');
  const keyPath = path.join(dir, 'root-ca.key');
  const certOut = certPem.endsWith('\n') ? certPem : `${certPem}\n`;
  const keyOut = keyPem.endsWith('\n') ? keyPem : `${keyPem}\n`;
  fs.writeFileSync(certPath, certOut, { encoding: 'utf8', mode: 0o644 });
  fs.writeFileSync(keyPath, keyOut, { encoding: 'utf8', mode: 0o600 });

  const certStat = fs.statSync(certPath);
  const keyStat = fs.statSync(keyPath);
  logger.info('Provisioning Root CA: wrote files from env (CAService will load these paths)', {
    certPath,
    keyPath,
    cert_file_bytes: certStat.size,
    key_file_bytes: keyStat.size,
    caStoragePath: dir
  });
  return dir;
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
    /**
     * Broker CA + client cert/key: only from MQTT_TLS_*_BASE64 / MQTT_TLS_*_PEM env.
     * Startup writes PEMs under dataDir/.mqtt-tls/ and these fields are read back from disk.
     */
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

export interface KafkaConfig {
  enabled: boolean;
  brokers: string[];
  clientId: string;
  defaultTopic: string;
  ssl: boolean;
  sasl?: {
    mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512';
    username: string;
    password: string;
  };
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
  kafka: KafkaConfig;
  auth: AuthConfig;
  app: AppEnvConfig;
}

export function loadConfig(): AppConfig {
  const dataDir = process.env.DATA_DIR || './data';

  const provisioningCaDirFromEnv = writeProvisioningRootCaFromEnv();

  const mtlsOnlyEnv =
    process.env.MQTT_MTLS_ONLY === 'true' ||
    process.env.MQTT_MTLS_ONLY === '1' ||
    process.env.MQTT_AUTH_X509_ONLY === 'true';
  const authX509Only = mtlsOnlyEnv || true;

  if (process.env.MQTT_TLS_CA?.trim()) {
    logger.warn(
      'MQTT_TLS_CA is ignored; use MQTT_TLS_CA_BASE64 or MQTT_TLS_CA_PEM / MQTT_TLS_CA_CERT. Material is written to DATA_DIR/.mqtt-tls/ at startup.'
    );
  }
  if (process.env.MQTT_TLS_CLIENT_CERT?.trim()) {
    logger.warn(
      'MQTT_TLS_CLIENT_CERT is ignored; use MQTT_TLS_CLIENT_CERT_BASE64 or MQTT_TLS_CLIENT_CERT_PEM. Material is written to DATA_DIR/.mqtt-tls/ at startup.'
    );
  }
  if (process.env.MQTT_TLS_CLIENT_KEY?.trim()) {
    logger.warn(
      'MQTT_TLS_CLIENT_KEY is ignored; use MQTT_TLS_CLIENT_KEY_BASE64 or MQTT_TLS_CLIENT_KEY_PEM. Material is written to DATA_DIR/.mqtt-tls/ at startup.'
    );
  }

  const mqttRuntimeTls = writeAndReadMqttTlsRuntime(dataDir);
  const caPemResolved = mqttRuntimeTls.caPem;
  const clientCertPemResolved = mqttRuntimeTls.clientCertPem;
  const clientKeyPemResolved = mqttRuntimeTls.clientKeyPem;

  const tlsExplicitOn =
    process.env.MQTT_TLS_ENABLED === 'true' || process.env.MQTT_TLS === 'true';
  const tlsEnabled =
    tlsExplicitOn ||
    !!caPemResolved ||
    !!clientCertPemResolved ||
    !!clientKeyPemResolved ||
    !!process.env.MQTT_TLS_CA_BASE64?.trim() ||
    !!process.env.MQTT_TLS_CLIENT_CERT_BASE64?.trim() ||
    !!process.env.MQTT_TLS_CLIENT_KEY_BASE64?.trim() ||
    !!process.env.MQTT_TLS_CA_PEM?.trim() ||
    !!process.env.MQTT_TLS_CA_CERT?.trim() ||
    !!process.env.MQTT_TLS_CLIENT_CERT_PEM?.trim() ||
    !!process.env.MQTT_TLS_CLIENT_KEY_PEM?.trim();

  const config: AppConfig = {
    mqtt: {
      broker: process.env.MQTT_BROKER || 'broker.emqx.io',
      port: parseInt(process.env.MQTT_PORT || '1883'),
      clientId: process.env.MQTT_CLIENT_ID || `firmware-test-1234`,
      authX509Only,
      topicPrefix: process.env.MQTT_TOPIC_PREFIX || '',
      topicRoot: process.env.MQTT_TOPIC_ROOT || 'proof.mqtt',
      tls: {
        enabled: tlsEnabled,
        caPem: caPemResolved,
        clientCertPem: clientCertPemResolved,
        clientKeyPem: clientKeyPemResolved,
        rejectUnauthorized: process.env.MQTT_TLS_REJECT_UNAUTHORIZED !== 'false',
        servername:
          process.env.MQTT_TLS_SERVERNAME?.trim() ||
          process.env.MQTT_TLS_VERIFY_HOST?.trim() ||
          undefined
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
      caStoragePath:
        provisioningCaDirFromEnv ||
        (process.env.CA_STORAGE_PATH?.trim()
          ? path.isAbsolute(process.env.CA_STORAGE_PATH)
            ? process.env.CA_STORAGE_PATH
            : path.resolve(process.cwd(), process.env.CA_STORAGE_PATH)
          : DEFAULT_PROVISIONING_CA_STORAGE_PATH),
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
    kafka: {
      enabled: process.env.KAFKA_ENABLED === 'true',
      brokers: (() => {
        const raw = (process.env.KAFKA_BROKERS || 'localhost:9092')
          .split(',')
          .map(b => b.trim())
          .filter(Boolean);
        const normalized = raw.map(b => b.replace(/:3003$/, ':9092'));
        if (normalized.some((n, i) => n !== raw[i])) {
          logger.warn('KAFKA_BROKERS contained port 3003; Kafka uses 9092. Using 9092.');
        }
        return normalized;
      })(),
      clientId: process.env.KAFKA_CLIENT_ID || 'mqtt-publisher-lite',
      defaultTopic: process.env.KAFKA_DEFAULT_TOPIC || 'social-webhook-events',
      ssl: process.env.KAFKA_SSL === 'true',
      sasl: process.env.KAFKA_SASL_MECHANISM
        ? {
            mechanism: process.env.KAFKA_SASL_MECHANISM as 'plain' | 'scram-sha-256' | 'scram-sha-512',
            username: process.env.KAFKA_SASL_USERNAME || '',
            password: process.env.KAFKA_SASL_PASSWORD || ''
          }
        : undefined
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
    influxdb: {
      enabled: config.influxdb.enabled,
      url: config.influxdb.url,
      org: config.influxdb.org,
      bucket: config.influxdb.bucket
    },
    kafka: {
      enabled: config.kafka.enabled,
      brokers: config.kafka.brokers,
      defaultTopic: config.kafka.defaultTopic
    },
    env: config.app.env
  });

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

  if (config.mqtt.authX509Only) {
    const tls = config.mqtt.tls;
    if (!tls?.enabled) {
      throw new Error(
        'mTLS-only MQTT: set MQTT_TLS_ENABLED=true and provide CA + client cert/key via MQTT_TLS_*_BASE64 or MQTT_TLS_*_PEM (env only; app writes DATA_DIR/.mqtt-tls/ at startup — not broker/certs).'
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