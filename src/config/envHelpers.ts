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
