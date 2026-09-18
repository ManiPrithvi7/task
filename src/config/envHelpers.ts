import { logger } from '../utils/logger';

const deprecatedWarned = new Set<string>();

/** Log once when a legacy env var is used instead of the canonical name. */
export function warnDeprecatedEnv(legacy: string, canonical: string): void {
  const key = `${legacy}->${canonical}`;
  if (deprecatedWarned.has(key)) return;
  deprecatedWarned.add(key);
  logger.warn(`Deprecated environment variable ${legacy}; use ${canonical} instead`);
}

export function envString(primary: string, defaultValue: string, legacy?: string[]): string {
  const raw = process.env[primary]?.trim();
  if (raw) return raw;
  for (const leg of legacy ?? []) {
    const legRaw = process.env[leg]?.trim();
    if (legRaw) {
      warnDeprecatedEnv(leg, primary);
      return legRaw;
    }
  }
  return defaultValue;
}

export function envInt(primary: string, defaultValue: number, legacy?: string[]): number {
  const raw = process.env[primary]?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : defaultValue;
  }
  for (const leg of legacy ?? []) {
    const legRaw = process.env[leg]?.trim();
    if (legRaw) {
      warnDeprecatedEnv(leg, primary);
      const n = parseInt(legRaw, 10);
      return Number.isFinite(n) ? n : defaultValue;
    }
  }
  return defaultValue;
}

export function envBool(primary: string, defaultValue: boolean, legacy?: string[]): boolean {
  const raw = process.env[primary]?.trim();
  if (raw !== undefined && raw !== '') {
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    return defaultValue;
  }
  for (const leg of legacy ?? []) {
    const legRaw = process.env[leg]?.trim();
    if (legRaw !== undefined && legRaw !== '') {
      warnDeprecatedEnv(leg, primary);
      if (legRaw === 'true' || legRaw === '1') return true;
      if (legRaw === 'false' || legRaw === '0') return false;
      return defaultValue;
    }
  }
  return defaultValue;
}

const PRODUCTION_MQTT_CLIENT_ID = 'proof-server';

/**
 * MQTT brokers allow one session per client ID. In development, avoid using the
 * production ID on the shared broker (and avoid colliding with other local npm run dev).
 */
export function resolveMqttClientId(): string {
  const explicit = process.env.MQTT_CLIENT_ID?.trim();
  const strict =
    process.env.MQTT_CLIENT_ID_STRICT === 'true' || process.env.MQTT_CLIENT_ID_STRICT === '1';
  const base = explicit || PRODUCTION_MQTT_CLIENT_ID;

  if (strict) return base;

  const env = process.env.NODE_ENV?.trim() || 'development';
  if (env === 'development' || env === 'test') {
    if (base === PRODUCTION_MQTT_CLIENT_ID) {
      return `${base}-dev-${process.pid}`;
    }
  }

  return base;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

/** True when TEST_OTA env bypass is active (dev/CI only — blocked in production). */
export function isTestOtaEnabled(): boolean {
  return process.env.TEST_OTA === 'true';
}

export type StimTestOtaEnvSeed = {
  version: string;
  sha256: string;
  signature: string;
  sizeBytes: number;
  downloadUrl?: string;
};

/** True when stim-device TEST_OTA_URL is set (allowlisted /active OTA). */
export function isStimTestOtaUrlSet(): boolean {
  return Boolean(process.env.TEST_OTA_URL?.trim());
}

function parseOptionalTestOtaUrl(): string | undefined {
  const downloadUrl = process.env.TEST_OTA_URL?.trim();
  if (!downloadUrl) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(downloadUrl);
  } catch {
    throw new Error('TEST_OTA_URL must be a valid http(s) URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('TEST_OTA_URL must be a valid http(s) URL');
  }
  return downloadUrl;
}

/**
 * TEST_OTA_VERSION / SHA256 / SIGNATURE / SIZE_BYTES for Redis seed.
 * Returns null when none are set. Throws if the set is partial or invalid.
 */
export function parseStimTestOtaEnvSeed(): StimTestOtaEnvSeed | null {
  const version = process.env.TEST_OTA_VERSION?.trim();
  const sha256Raw = process.env.TEST_OTA_SHA256?.trim();
  const signature = process.env.TEST_OTA_SIGNATURE?.trim();
  const sizeRaw = process.env.TEST_OTA_SIZE_BYTES?.trim();
  if (!version && !sha256Raw && !signature && !sizeRaw) {
    return null;
  }
  if (!version) {
    throw new Error('TEST_OTA_VERSION is required when any TEST_OTA_* metadata is set');
  }
  const sha256 = sha256Raw?.toLowerCase();
  if (!sha256 || !SHA256_HEX.test(sha256)) {
    throw new Error('TEST_OTA_SHA256 must be 64 lowercase hex characters');
  }
  if (!signature) {
    throw new Error('TEST_OTA_SIGNATURE is required when TEST_OTA_VERSION is set');
  }
  const sigBytes = Buffer.from(signature, 'base64');
  if (sigBytes.length !== 64) {
    throw new Error('TEST_OTA_SIGNATURE must be base64 of a 64-byte Ed25519 signature');
  }
  const sizeBytes = sizeRaw ? Number.parseInt(sizeRaw, 10) : NaN;
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error('TEST_OTA_SIZE_BYTES must be a positive integer');
  }
  return {
    version,
    sha256,
    signature,
    sizeBytes,
    downloadUrl: parseOptionalTestOtaUrl()
  };
}

function nodeEnvName(): string {
  return process.env.NODE_ENV?.trim() || 'development';
}

/**
 * TEST_OTA / TEST_OTA_URL bypasses — allowed only outside production.
 * Call from validateConfig and any route that honors TEST_OTA.
 */
export function assertTestOtaAllowed(): void {
  const env = nodeEnvName();
  if (isTestOtaEnabled() && env === 'production') {
    throw new Error('TEST_OTA=true is not allowed when NODE_ENV=production');
  }
  if (isStimTestOtaUrlSet() && env === 'production') {
    throw new Error('TEST_OTA_URL is not allowed when NODE_ENV=production');
  }
  if (env === 'production') {
    const hasMeta =
      Boolean(process.env.TEST_OTA_VERSION?.trim()) ||
      Boolean(process.env.TEST_OTA_SHA256?.trim()) ||
      Boolean(process.env.TEST_OTA_SIGNATURE?.trim()) ||
      Boolean(process.env.TEST_OTA_SIZE_BYTES?.trim());
    if (hasMeta) {
      throw new Error('TEST_OTA_* offer metadata is not allowed when NODE_ENV=production');
    }
  }
  if (isStimTestOtaUrlSet()) {
    parseOptionalTestOtaUrl();
  }
  parseStimTestOtaEnvSeed();
}
