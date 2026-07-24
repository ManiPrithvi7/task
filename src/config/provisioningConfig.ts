import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { envString } from './envHelpers';

export interface ProvisioningConfig {
  enabled: boolean;
  tokenTTL: number;
  jwtSecret: string;
  caStoragePath: string;
  rootCAValidityYears: number;
  deviceCertValidityDays: number;
  certificateDbPath: string;
  requireMtlsForRegistration: boolean;
  cnPrefix: string;
  cnFormat: 'legacy' | 'structured';
  auditLogEnabled: boolean;
  transparencyLogEnabled: boolean;
  enforceRuntimeKuEku: boolean;
  chainValidationEnabled: boolean;
  intermediateCAEnabled: boolean;
  certProfile?: {
    validityDays: number;
    keyUsage: string[];
    extendedKeyUsage: string[];
    requireSanDeviceId: boolean;
    minKeyBits: number;
  };
}

export const DEFAULT_PROVISIONING_CA_STORAGE_PATH = path.resolve(
  process.env.DATA_DIR?.trim() || path.resolve(process.cwd(), 'data'),
  'certs'
);

function normalizeMqttPemFromEnv(raw: string): string {
  return raw.trim().replace(/\\n/g, '\n');
}

function decodeBase64ToUtf8(b64: string | undefined): string | undefined {
  if (!b64?.trim()) return undefined;
  try {
    return Buffer.from(b64.trim(), 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

function looksLikeCertificatePem(value: string): boolean {
  return value.includes('-----BEGIN CERTIFICATE-----');
}

function looksLikePrivateKeyPem(value: string): boolean {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(value);
}

export function getProvisioningRootCaCertFromEnv(): string | undefined {
  const fromB64 = decodeBase64ToUtf8(process.env.MQTT_TLS_CA_BASE64);
  const certCandidate = fromB64 ? normalizeMqttPemFromEnv(fromB64) : undefined;
  if (certCandidate && looksLikeCertificatePem(certCandidate)) return certCandidate;
  return undefined;
}

export function getProvisioningRootCaKeyFromEnv(): string | undefined {
  const fromB64 = decodeBase64ToUtf8(process.env.MQTT_TLS_CA_KEY_BASE64);
  const keyCandidate = fromB64 ? normalizeMqttPemFromEnv(fromB64) : undefined;
  if (keyCandidate && looksLikePrivateKeyPem(keyCandidate)) return keyCandidate;
  return undefined;
}

function sha256HexPrefix(pemUtf8: string, hexChars = 16): string {
  return crypto.createHash('sha256').update(pemUtf8, 'utf8').digest('hex').slice(0, hexChars);
}

function describePrivateKeyPemKind(pem: string): 'PKCS#1 RSA' | 'PKCS#8' | 'EC' | 'unknown' {
  if (pem.includes('BEGIN RSA PRIVATE KEY')) return 'PKCS#1 RSA';
  if (pem.includes('BEGIN PRIVATE KEY')) return 'PKCS#8';
  if (pem.includes('BEGIN EC PRIVATE KEY')) return 'EC';
  return 'unknown';
}

export function writeProvisioningRootCaFromEnv(): string | undefined {
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

export function loadProvisioningConfig(
  dataDir: string,
  provisioningCaDirFromEnv?: string
): ProvisioningConfig {
  return {
    enabled: process.env.PROVISIONING_ENABLED !== 'false',
    tokenTTL: parseInt(process.env.PROVISIONING_TOKEN_TTL || '6000', 10),
    jwtSecret: (() => {
      const fromEnv = process.env.JWT_SECRET?.trim() || process.env.PROVISIONING_JWT_SECRET?.trim();
      if (fromEnv) return fromEnv;
      if (envString('NODE_ENV', 'development') === 'production') return '';
      return 'mqtt-publisher-lite-secret-key-change-in-production';
    })(),
    caStoragePath:
      provisioningCaDirFromEnv ||
      (process.env.CA_STORAGE_PATH?.trim()
        ? path.isAbsolute(process.env.CA_STORAGE_PATH)
          ? process.env.CA_STORAGE_PATH
          : path.resolve(process.cwd(), process.env.CA_STORAGE_PATH)
        : DEFAULT_PROVISIONING_CA_STORAGE_PATH),
    rootCAValidityYears: parseInt(process.env.ROOT_CA_VALIDITY_YEARS || '10', 10),
    deviceCertValidityDays: parseInt(process.env.DEVICE_CERT_VALIDITY_DAYS || '90', 10),
    certificateDbPath: process.env.CERTIFICATE_DB_PATH || `${dataDir}/certificates.db`,
    requireMtlsForRegistration: process.env.REQUIRE_MTLS_FOR_REGISTRATION !== 'false',
    cnPrefix: process.env.CERT_CN_PREFIX || 'PROOF_',
    cnFormat: process.env.CERT_CN_FORMAT === 'structured' ? 'structured' : 'legacy',
    auditLogEnabled: process.env.PKI_AUDIT_LOG_ENABLED !== 'false',
    transparencyLogEnabled: process.env.TRANSPARENCY_LOG_ENABLED !== 'false',
    enforceRuntimeKuEku: process.env.ENFORCE_RUNTIME_KU_EKU !== 'false',
    chainValidationEnabled: process.env.CHAIN_VALIDATION_ENABLED !== 'false',
    intermediateCAEnabled: process.env.INTERMEDIATE_CA_ENABLED === 'true',
    certProfile: {
      validityDays: parseInt(
        process.env.CERT_VALIDITY_DAYS || String(process.env.DEVICE_CERT_VALIDITY_DAYS || '90'),
        10
      ),
      keyUsage: (process.env.CERT_KEY_USAGE || 'digitalSignature,keyEncipherment')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      extendedKeyUsage: (process.env.CERT_EXTENDED_KEY_USAGE || 'clientAuth')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      requireSanDeviceId: process.env.CERT_SAN_REQUIRE_DEVICE_ID !== 'false',
      minKeyBits: parseInt(process.env.CERT_MIN_KEY_BITS || '2048', 10)
    }
  };
}
