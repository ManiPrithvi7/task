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
  /** Preferred single connection string (e.g. Upstash): rediss://default:...@host:6379 */
  url?: string;
  db?: number;         // Redis database number (default 0)
  keyPrefix?: string;  // Key prefix for namespacing
}

export interface AppEnvConfig {
  env: string;
  logLevel: string;
}

export interface AuthConfig {
  secret: string;  // AUTH_SECRET from environment
}

/**
 * POST target for Instagram metrics (serverless worker, e.g. Vercel). Main server forwards device batches here.
 */
export interface InstagramServerlessConfig {
  fetchUrl: string;
  apiKey?: string;
  timeoutMs: number;
}

/**
 * Instagram dual-scheduler tuning (Redis Lua + HTTP serverless fetch).
 */
export interface InstagramPollingConfig {
  priorityIntervalMs: number;
  backgroundIntervalMs: number;
  priorityTtlMs: number;
  batchSize: number;
  backoffThreshold: number;
  backoffWindowMs: number;
  /** Max devices processed from priority zset per tick (Phase C fairness). 0 = unlimited. */
  priorityCapPerCycle: number;
  /** Trim priority_zset to at most this many members (removes soonest-expiring first). 0 = off. */
  priorityZsetMaxMembers: number;
  /** Repeat attention: max ms added to previous expiry per touch (Phase C decay). 0 = off. */
  priorityRefreshMaxDeltaMs: number;
  /** Hard ceiling: priority score ≤ now + this. 0 = off. */
  priorityAbsoluteMaxFutureMs: number;
  /** Background tick: max devices to consider after fair rotation. 0 = unlimited. */
  backgroundCapPerCycle: number;
  /** Rotate background cursor across active devices (Redis `ig:bg:fair_offset`). Default true. */
  backgroundFairRotate: boolean;
  /** Max serverless invocations per rolling minute (all poller paths). 0 = off. */
  globalFetchBudgetPerMinute: number;
  /** Min interval between fetch requests for same device from poller (0 = off). */
  fetchDedupeWindowMs: number;
}

export interface InfluxDBConfig {
  /**
   * Implicit: non-empty INFLUXDB_TOKEN. No INFLUXDB_ENABLED flag — unset token to skip Influx locally.
   * With disk queue (default): startup continues if HTTP checks fail; writes buffer to DATA_DIR.
   * With INFLUXDB_DISK_QUEUE=false: startup fails if Influx health fails (legacy strict mode).
   */
  enabled: boolean;
  url: string;
  token: string;
  org: string;
  bucket: string;
  /** Default true — append line protocol to disk; background worker POSTs batches over HTTP. */
  diskQueueEnabled: boolean;
  diskQueuePath: string;
  diskQueueFlushMs: number;
  diskQueueBatchMax: number;
  diskQueueMaxLinesPerFile: number;
}

/**
 * Trim and strip trailing slashes for Influx base URL.
 *
 * Accepts either a full URL (`https://host:port`) or a host[:port] string (common in PaaS dashboards),
 * in which case we default to `http://` so the Influx client has a valid scheme.
 */
export function normalizeInfluxDbUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return trimmed;
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
  influxdb?: InfluxDBConfig;
  instagramPolling?: InstagramPollingConfig;
  /**
   * Optional serverless worker URL. When set, all poller fetches POST here.
   * When unset, the poller still runs (requires Redis) and calls Instagram Graph from this process.
   */
  instagramServerless?: InstagramServerlessConfig;
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

  const redisUrl = process.env.REDIS_URL?.trim();

  const instagramServerless: InstagramServerlessConfig = {
    fetchUrl: process.env.INSTAGRAM_SERVERLESS_URL?.trim() || process.env.VERCEL_INSTAGRAM_FETCH_URL?.trim() || '',
    apiKey:
      process.env.INSTAGRAM_SERVERLESS_API_KEY?.trim() ||
      process.env.VERCEL_INSTAGRAM_FETCH_API_KEY?.trim() ||
      undefined,
    timeoutMs: parseInt(process.env.INSTAGRAM_SERVERLESS_TIMEOUT_MS || '30000', 10)
  };

  const instagramPolling: InstagramPollingConfig = {
    priorityIntervalMs: parseInt(process.env.IG_POLL_PRIORITY_INTERVAL_MS || '15000', 10),
    backgroundIntervalMs: parseInt(process.env.IG_POLL_BACKGROUND_INTERVAL_MS || '90000', 10),
    priorityTtlMs: parseInt(process.env.IG_POLL_PRIORITY_TTL_MS || '120000', 10),
    batchSize: parseInt(process.env.IG_POLL_BATCH_SIZE || '50', 10),
    backoffThreshold: parseInt(process.env.IG_POLL_BACKOFF_THRESHOLD || '6', 10),
    backoffWindowMs: parseInt(process.env.IG_POLL_BACKOFF_WINDOW_MS || '60000', 10),
    priorityCapPerCycle: parseInt(process.env.IG_POLL_PRIORITY_CAP_PER_CYCLE || '0', 10),
    priorityZsetMaxMembers: parseInt(process.env.IG_POLL_PRIORITY_ZSET_MAX_MEMBERS || '0', 10),
    priorityRefreshMaxDeltaMs: parseInt(process.env.IG_POLL_PRIORITY_REFRESH_MAX_DELTA_MS || '0', 10),
    priorityAbsoluteMaxFutureMs: parseInt(process.env.IG_POLL_PRIORITY_MAX_FUTURE_MS || '0', 10),
    backgroundCapPerCycle: parseInt(process.env.IG_POLL_BACKGROUND_CAP_PER_CYCLE || '0', 10),
    backgroundFairRotate: process.env.IG_POLL_BACKGROUND_FAIR_ROTATE === 'false' ? false : true,
    globalFetchBudgetPerMinute: parseInt(process.env.IG_GLOBAL_FETCH_BUDGET_PER_MIN || '0', 10),
    fetchDedupeWindowMs: parseInt(process.env.IG_FETCH_DEDUPE_WINDOW_MS || '45000', 10)
  };

  const bgMultRaw = process.env.IG_POLL_BACKGROUND_INTERVAL_MULTIPLIER_LOW_POWER?.trim();
  if (bgMultRaw) {
    const bgMult = parseFloat(bgMultRaw);
    if (bgMult > 1 && Number.isFinite(bgMult)) {
      instagramPolling.backgroundIntervalMs = Math.round(instagramPolling.backgroundIntervalMs * bgMult);
      logger.info('IG_POLL_BACKGROUND_INTERVAL_MULTIPLIER_LOW_POWER applied to background interval', {
        multiplier: bgMult,
        backgroundIntervalMs: instagramPolling.backgroundIntervalMs
      });
    }
  }
  const influxToken = process.env.INFLUXDB_TOKEN?.trim() || '';
  /** Prefer INFLUXDB_URL; fall back to INFLUXDB_HOST (many stacks use HOST + PORT). */
  const influxUrlRaw =
    process.env.INFLUXDB_URL?.trim() ||
    process.env.INFLUXDB_HOST?.trim() ||
    'http://localhost:8086';
  const influxUrl = normalizeInfluxDbUrl(influxUrlRaw);
  /** Influx runs whenever an API token is provided (essential mode for that deployment). */
  const influxEnabled = influxToken.length > 0;
  const influxDiskQueueDisabled =
    process.env.INFLUXDB_DISK_QUEUE === 'false' || process.env.INFLUXDB_DISK_QUEUE === '0';
  const influxDiskQueueEnabled = influxEnabled && !influxDiskQueueDisabled;
  const influxQueuePathRaw = process.env.INFLUXDB_DISK_QUEUE_PATH?.trim();
  const influxQueuePath = influxQueuePathRaw
    ? path.isAbsolute(influxQueuePathRaw)
      ? influxQueuePathRaw
      : path.resolve(process.cwd(), influxQueuePathRaw)
    : path.join(path.resolve(dataDir), 'influx-write-queue.lines');
  const influxQueueFlushMs = Math.max(
    1000,
    parseInt(process.env.INFLUXDB_QUEUE_FLUSH_MS || '5000', 10) || 5000
  );
  const influxQueueBatchMax = Math.max(
    1,
    parseInt(process.env.INFLUXDB_QUEUE_BATCH_MAX || '500', 10) || 500
  );
  const influxQueueMaxLinesRaw = parseInt(process.env.INFLUXDB_QUEUE_MAX_LINES_PER_FILE || '100000', 10);
  const influxQueueMaxLinesPerFile =
    Number.isFinite(influxQueueMaxLinesRaw) && influxQueueMaxLinesRaw > 0 ? influxQueueMaxLinesRaw : 100_000;

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
      enabled: Boolean(redisUrl),
      url: redisUrl,
      db: parseInt(process.env.REDIS_DB || '0', 10),
      keyPrefix: process.env.REDIS_KEY_PREFIX || 'mqtt-lite:',
    },
    auth: {
      secret: process.env.AUTH_SECRET || ''
    },
    app: {
      env: process.env.NODE_ENV || 'development',
      logLevel: process.env.LOG_LEVEL || 'info'
    },
    instagramServerless,
    influxdb: {
      enabled: influxEnabled,
      url: influxUrl,
      token: influxToken,
      org: process.env.INFLUXDB_ORG?.trim() || 'statsmqtt',
      /** Matches typical Influx 2 Docker init (e.g. DOCKER_INFLUXDB_INIT_BUCKET); override via INFLUXDB_BUCKET. */
      bucket: process.env.INFLUXDB_BUCKET?.trim() || 'metrics',
      diskQueueEnabled: influxDiskQueueEnabled,
      diskQueuePath: influxQueuePath,
      diskQueueFlushMs: influxQueueFlushMs,
      diskQueueBatchMax: influxQueueBatchMax,
      diskQueueMaxLinesPerFile: influxQueueMaxLinesPerFile
    },
    instagramPolling
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
      host: config.redis.url ? '(via REDIS_URL)' : 'not set',
      port: config.redis.url ? '(via REDIS_URL)' : 'not set',
      keyPrefix: config.redis.keyPrefix
    },
    influxdb: config.influxdb?.enabled
      ? {
          url: config.influxdb.url,
          org: config.influxdb.org,
          bucket: config.influxdb.bucket,
          diskQueue: config.influxdb.diskQueueEnabled,
          diskQueuePath: config.influxdb.diskQueueEnabled ? config.influxdb.diskQueuePath : undefined,
          token: '(set)'
        }
      : { configured: false, hint: 'set INFLUXDB_TOKEN (optional INFLUXDB_URL)' },
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
  // Redis: only one supported config method is REDIS_URL (rediss://...).
  // if (config.app.env === 'production' && !config.redis.url) {
  //   throw new Error(
  //     'REDIS_URL is required in production. Set REDIS_URL to your Upstash Redis TLS endpoint (rediss://...@...upstash.io:6379).'
  //   );
  // }
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

  logger.info('Configuration validated successfully');
}

// # Replace AUTH_TOKEN with your admin JWT and PUBLISHER_URL with your server URL
// PROV=$(curl -s -X POST "http://localhost:3002/api/v1/onboarding" \
//   -H "Authorization: Bearer eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2Q0JDLUhTNTEyIiwia2lkIjoic2JSbkJueXR2VDBzN1VkTXE2VGhMUmxhU2ljcU1reHFERi1FRGRoV2NJNldTaUtwT0tORkY2eFllMm1YaGwtbFVXVlh2VXJKakFienpLY0hDRTlOYXcifQ..vCOb0KfIkeYbSpYvm2zmmw.Ne7vrHllldHCfCXo0n5o6zlLPS7dsAuGV2NjQWtX0kioTDdfwIclJBp9vkObjiWfZq3zIfWbXl9edB4TgHneAxlASo5QglL_JrnEyqgnz8eLIHpQsrHM5fkBeLGLf3hyHe_0HQrElwqSF61EE4SWX2-8bq0jgWEkElcmyYHgo32V2SjEUHxA3ParFhDz0Bx9ICouCzxvXTSsui61XcC3CAIMJGN4WYxZu5Ug157hmkPVsIhuFYuSDt4dQwkiotF0cjLi_F9A0L7u3gsPbUInlpJ2dQyqtz2cJ3XY6ceJMC60adFqECMjnro7LMH62_Kifm6o-hc6KtuALuc_7hqPGzp_Sxyn6pLMgSbDMOne7F5Cr446ujPWByGVaaWq_1v48GAraozlfxRfjKkm2CMhj6-O4dEFzMhXrUE3R-r9AfE25vd_DROo3zY50h_lpD6P.DeVYKY5KqNgHXULXboDy-5UTsQQLm6a7xiD5U30pgjE" \
//   -H "Content-Type: application/json" \
//   -d '{"device_id":"unified-server-dev"}' | jq -r '.provisioning_token')

// echo "Provisioning token: $PROV"