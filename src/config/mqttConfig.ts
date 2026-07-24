import { logger } from '../utils/logger';
import { normalizeTlsPem, resolveMqttTlsServername } from '../utils/mqttTlsOptions';
import { resolveMqttClientId } from './envHelpers';

export interface MqttConfig {
  broker: string;
  port: number;
  clientId: string;
  authX509Only?: boolean;
  username?: string;
  password?: string;
  topicPrefix: string;
  topicRoot: string;
  reconnectPeriod?: number;
  maxReconnectAttempts?: number;
  dnsPreflightEnabled?: boolean;
  tls?: {
    enabled?: boolean;
    caPem?: string;
    clientCertPem?: string;
    clientKeyPem?: string;
    rejectUnauthorized?: boolean;
    servername?: string;
  };
}

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
    caPem: caPem && looksLikeCertificatePem(caPem) ? normalizeTlsPem(caPem) : undefined,
    clientCertPem:
      clientCertPem && looksLikeCertificatePem(clientCertPem) ? normalizeTlsPem(clientCertPem) : undefined,
    clientKeyPem:
      clientKeyPem && looksLikePrivateKeyPem(clientKeyPem) ? normalizeTlsPem(clientKeyPem) : undefined
  };
}

function loadMqttTlsFromEnv(): {
  caPem?: string;
  clientCertPem?: string;
  clientKeyPem?: string;
} {
  const resolved = resolveMqttTlsPemFromEnv();
  const { caPem, clientCertPem, clientKeyPem } = resolved;
  if (!caPem && !clientCertPem && !clientKeyPem) {
    return {};
  }
  logger.info('MQTT TLS credentials loaded from environment (in-memory only)', {
    hasCa: !!caPem,
    hasClientCert: !!clientCertPem,
    hasClientKey: !!clientKeyPem
  });
  return resolved;
}

export function setMqttTlsClientPem(
  config: { mqtt: MqttConfig },
  clientCertPem: string,
  clientKeyPem: string
): void {
  if (!config.mqtt.tls) {
    config.mqtt.tls = { enabled: true };
  }
  config.mqtt.tls.clientCertPem = normalizeTlsPem(clientCertPem);
  config.mqtt.tls.clientKeyPem = normalizeTlsPem(clientKeyPem);
  config.mqtt.tls.enabled = true;
}

export function loadMqttConfig(): MqttConfig {
  const mqttUsername = process.env.MQTT_USERNAME?.trim() || '';
  const mqttPassword = process.env.MQTT_PASSWORD?.trim() || '';
  const hasMqttUserPass = mqttUsername.length > 0 && mqttPassword.length > 0;
  const mtlsOnlyExplicitOff =
    process.env.MQTT_MTLS_ONLY === 'false' ||
    process.env.MQTT_MTLS_ONLY === '0' ||
    process.env.MQTT_AUTH_X509_ONLY === 'false';
  const mtlsOnlyExplicitOn =
    process.env.MQTT_MTLS_ONLY === 'true' ||
    process.env.MQTT_MTLS_ONLY === '1' ||
    process.env.MQTT_AUTH_X509_ONLY === 'true';
  const authX509Only = !mtlsOnlyExplicitOff && (mtlsOnlyExplicitOn || !hasMqttUserPass);

  if (process.env.MQTT_TLS_CA?.trim()) {
    logger.warn(
      'MQTT_TLS_CA is ignored; use MQTT_TLS_CA_BASE64 or MQTT_TLS_CA_PEM / MQTT_TLS_CA_CERT (in-memory only).'
    );
  }
  if (process.env.MQTT_TLS_CLIENT_CERT?.trim()) {
    logger.warn(
      'MQTT_TLS_CLIENT_CERT is ignored; use MQTT_TLS_CLIENT_CERT_BASE64 or MQTT_TLS_CLIENT_CERT_PEM (in-memory only).'
    );
  }
  if (process.env.MQTT_TLS_CLIENT_KEY?.trim()) {
    logger.warn(
      'MQTT_TLS_CLIENT_KEY is ignored; use MQTT_TLS_CLIENT_KEY_BASE64 or MQTT_TLS_CLIENT_KEY_PEM (in-memory only).'
    );
  }

  const mqttRuntimeTls = loadMqttTlsFromEnv();
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

  return {
    broker: process.env.MQTT_BROKER || 'broker.withproof.io',
    port: parseInt(process.env.MQTT_PORT || '8883', 10),
    clientId: resolveMqttClientId(),
    authX509Only,
    username: hasMqttUserPass ? mqttUsername : undefined,
    password: hasMqttUserPass ? mqttPassword : undefined,
    topicPrefix: process.env.MQTT_TOPIC_PREFIX || '',
    topicRoot: process.env.MQTT_TOPIC_ROOT || 'proof.mqtt',
    reconnectPeriod: parseInt(process.env.MQTT_RECONNECT_PERIOD || '2000', 10),
    maxReconnectAttempts: parseInt(process.env.MQTT_MAX_RECONNECT_ATTEMPTS ?? '0', 10),
    dnsPreflightEnabled: process.env.MQTT_DNS_PREFLIGHT_ENABLED === 'true',
    tls: {
      enabled: tlsEnabled,
      caPem: caPemResolved,
      clientCertPem: clientCertPemResolved,
      clientKeyPem: clientKeyPemResolved,
      rejectUnauthorized: process.env.MQTT_TLS_REJECT_UNAUTHORIZED !== 'false',
      servername: resolveMqttTlsServername(
        process.env.MQTT_BROKER || 'broker.withproof.io',
        process.env.MQTT_TLS_SERVERNAME?.trim() || process.env.MQTT_TLS_VERIFY_HOST?.trim()
      )
    }
  };
}
