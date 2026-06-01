import * as dns from 'dns';
import * as net from 'net';
import * as tls from 'tls';
import type { IClientOptions } from 'mqtt';
import { caForBrokerTls } from './tlsBrokerCa';

type TlsVersion = tls.SecureVersion;

function readTlsVersion(name: string, fallback: TlsVersion): TlsVersion {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (raw === 'TLSv1.2' || raw === 'TLSv1.3') return raw;
  return fallback;
}

/** TLS version range + optional cipher list (env: MQTT_TLS_MIN_VERSION, MQTT_TLS_MAX_VERSION, MQTT_TLS_CIPHERS). */
export function readMqttTlsVersionOptions(): Pick<tls.ConnectionOptions, 'minVersion' | 'maxVersion' | 'ciphers'> {
  const minVersion = readTlsVersion('MQTT_TLS_MIN_VERSION', 'TLSv1.2');
  const maxVersion = readTlsVersion('MQTT_TLS_MAX_VERSION', 'TLSv1.3');
  const ciphers = process.env.MQTT_TLS_CIPHERS?.trim() || undefined;
  return { minVersion, maxVersion, ...(ciphers ? { ciphers } : {}) };
}

function trustCaPem(caPem: string): string | string[] {
  const normalized = normalizeTlsPem(caPem);
  if (process.env.MQTT_TLS_CA_ONLY === 'true') return normalized;
  return caForBrokerTls(normalized);
}

/** Normalize PEM from env/base64 (CRLF, missing trailing newline). */
export function normalizeTlsPem(pem: string): string {
  const normalized = pem.replace(/\r\n/g, '\n').trim();
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

/** Cert hostname for SNI / verification (may differ from MQTT_BROKER TCP host on Railway). */
export function resolveMqttTlsServername(broker: string, explicit?: string): string {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  if (/\.proxy\.rlwy\.net$/i.test(broker)) return 'broker.withproof.io';
  return broker;
}

export interface MqttTlsConnectMaterial {
  caPem: string;
  clientCertPem?: string;
  clientKeyPem?: string;
  rejectUnauthorized: boolean;
  servername: string;
}

/** Node tls.connect options shared by pre-check and diagnostics. */
export function buildNodeTlsConnectOptions(
  material: MqttTlsConnectMaterial,
  host: string,
  port: number
): tls.ConnectionOptions {
  const servername = material.servername;
  const opts: tls.ConnectionOptions = {
    host,
    port,
    ca: trustCaPem(material.caPem),
    servername,
    rejectUnauthorized: material.rejectUnauthorized !== false,
    ...readMqttTlsVersionOptions()
  };

  if (material.clientCertPem?.includes('-----BEGIN')) {
    opts.cert = normalizeTlsPem(material.clientCertPem);
  }
  if (material.clientKeyPem?.includes('-----BEGIN')) {
    opts.key = normalizeTlsPem(material.clientKeyPem);
  }

  if (servername !== host) {
    opts.checkServerIdentity = (_hostname: string, cert: tls.PeerCertificate) =>
      tls.checkServerIdentity(servername, cert);
  }

  return opts;
}

/**
 * When SNI (cert identity) differs from MQTT_BROKER, resolve broker to IP so mqtt.js
 * does not overwrite `servername` with the proxy hostname (see mqtt/build/lib/connect/tls.js).
 */
export async function resolveMqttTcpHost(
  broker: string,
  servername: string
): Promise<{ connectHost: string; brokerHost: string }> {
  const isIp = netIsIp(broker);
  if (isIp || servername === broker) {
    return { connectHost: broker, brokerHost: broker };
  }
  const { address } = await dns.promises.lookup(broker);
  return { connectHost: address, brokerHost: broker };
}

function netIsIp(host: string): boolean {
  return net.isIP(host) !== 0;
}

/** Apply mTLS fields to mqtt.js client options (after resolveMqttTcpHost). */
export function applyMqttJsTlsOptions(
  options: IClientOptions,
  material: MqttTlsConnectMaterial,
  connectHost: string,
  brokerHost: string
): void {
  const servername = material.servername;

  options.ca = trustCaPem(material.caPem);
  if (material.clientCertPem?.includes('-----BEGIN')) {
    options.cert = normalizeTlsPem(material.clientCertPem);
  }
  if (material.clientKeyPem?.includes('-----BEGIN')) {
    options.key = normalizeTlsPem(material.clientKeyPem);
  }
  options.rejectUnauthorized = material.rejectUnauthorized !== false;
  options.servername = servername;
  Object.assign(options, readMqttTlsVersionOptions());

  if (servername !== brokerHost) {
    (options as any).checkServerIdentity = (_hostname: string, cert: tls.PeerCertificate) =>
      tls.checkServerIdentity(servername, cert);
  }

  if (connectHost !== brokerHost) {
    options.host = connectHost;
    options.hostname = connectHost;
  }
}
