#!/usr/bin/env node
/**
 * Push OTA via proofmqtt server when the device publishes /active.
 * Server builds download_url from OCI Object Storage (presigned PAR by default).
 *
 * Usage:
 *   AUTH_TOKEN=<jwt> node scripts/ota-e2e/push-ota-on-active.js [DEVICE_ID]
 *
 * Env (from proofmqtt/.env when unset):
 *   OTA_API_BASE | PUBLIC_APP_URL — server base URL
 *   OTA_FIRMWARE_VERSION — override release version
 *   OTA_PUSH_FORCE=1 — force push even if device reports same version
 */
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');

const REPO_ROOT = path.resolve(__dirname, '../..');
const envPath = path.join(REPO_ROOT, '.env');
const manifestPath = path.join(__dirname, 'artifacts/manifest.json');

const defaultDeviceCertDir = path.resolve(REPO_ROOT, '../mqttclient/main/mtls_client/certs');
if (!process.env.OTA_E2E_DEVICE_CERT_DIR && fs.existsSync(path.join(defaultDeviceCertDir, 'primary/client.crt'))) {
  process.env.OTA_E2E_DEVICE_CERT_DIR = defaultDeviceCertDir;
}

if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

function b64(v) {
  return v ? Buffer.from(v, 'base64').toString('utf8') : undefined;
}

function readPem(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function resolveTlsMaterial() {
  const deviceCertDir = process.env.OTA_E2E_DEVICE_CERT_DIR;
  if (deviceCertDir) {
    const caPath = process.env.OTA_E2E_CA_PEM || path.join(deviceCertDir, 'ca_root.pem');
    const certPath = process.env.OTA_E2E_CLIENT_CERT_PEM || path.join(deviceCertDir, 'primary/client.crt');
    const keyPath = process.env.OTA_E2E_CLIENT_KEY_PEM || path.join(deviceCertDir, 'primary/client.key');
    return {
      ca: [readPem(caPath)],
      cert: readPem(certPath),
      key: readPem(keyPath),
      servername: process.env.MQTT_TLS_SERVERNAME || 'broker.withproof.io',
      rejectUnauthorized: process.env.MQTT_TLS_REJECT_UNAUTHORIZED !== 'false',
    };
  }
  return {
    ca: [b64(process.env.MQTT_TLS_CA_BASE64)],
    cert: b64(process.env.MQTT_TLS_CLIENT_CERT_BASE64),
    key: b64(process.env.MQTT_TLS_CLIENT_KEY_BASE64),
    servername: process.env.MQTT_TLS_SERVERNAME || process.env.MQTT_BROKER || 'broker.withproof.io',
    rejectUnauthorized: process.env.MQTT_TLS_REJECT_UNAUTHORIZED !== 'false',
  };
}

function resolveVersion() {
  if (process.env.OTA_FIRMWARE_VERSION?.trim()) {
    return process.env.OTA_FIRMWARE_VERSION.trim();
  }
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.version) return manifest.version;
  }
  return '';
}

const deviceId = process.argv[2] || process.env.OTA_DEVICE_ID || 'DEVICE-17';
const version = resolveVersion();
const token = process.env.AUTH_TOKEN?.trim();
const apiBase = (
  process.env.OTA_API_BASE?.trim() ||
  process.env.PUBLIC_APP_URL?.trim() ||
  'http://localhost:3002'
).replace(/\/$/, '');
const force = process.env.OTA_PUSH_FORCE === '1' || process.env.OTA_PUSH_FORCE === 'true';

if (!token) {
  console.error('AUTH_TOKEN is required (JWT for /api/v1/admin/ota/push).');
  console.error('Example:');
  console.error(
    `  AUTH_TOKEN=<jwt> node scripts/ota-e2e/push-ota-on-active.js ${deviceId}`
  );
  process.exit(1);
}

if (!version) {
  console.error('Set OTA_FIRMWARE_VERSION or create scripts/ota-e2e/artifacts/manifest.json (run sign-firmware.sh).');
  process.exit(1);
}

const topicRoot = process.env.MQTT_TOPIC_ROOT || 'proof.mqtt';
const activeTopic = `${topicRoot}/${deviceId}/active`;
const statusTopic = `${topicRoot}/${deviceId}/status`;

let pushCount = 0;
let pushInFlight = false;

async function pushViaServer(reason) {
  if (pushCount >= 5 || pushInFlight) return;
  pushInFlight = true;
  pushCount++;

  try {
    const res = await fetch(`${apiBase}/api/v1/admin/ota/push`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version,
        target: 'device',
        deviceIds: [deviceId],
        force,
      }),
    });
    const body = await res.json();
    console.log(
      `${reason}: server push #${pushCount} → ${deviceId} @ ${version}`,
      res.ok ? 'OK' : `HTTP ${res.status}`,
      JSON.stringify(body)
    );
    if (!res.ok) {
      console.error('Server push failed — device will not receive OCI download_url until this succeeds.');
    } else {
      console.log(`Device should receive download_url on ${process.env.PUBLIC_APP_URL || process.env.OTA_PUBLIC_BASE_URL || 'your configured domain'}/api/v1/ota/download/...`);
    }
  } catch (err) {
    console.error(`${reason}: server push error`, err instanceof Error ? err.message : String(err));
  } finally {
    pushInFlight = false;
  }
}

const url = `mqtts://${process.env.MQTT_BROKER || 'broker.withproof.io'}:${process.env.MQTT_PORT || 8883}`;
const tlsOpts = resolveTlsMaterial();

console.log(`Watching ${activeTopic} — push OTA ${version} via ${apiBase} on /active`);

const client = mqtt.connect(url, {
  clientId: process.env.OTA_E2E_MQTT_CLIENT_ID || `ota-push-on-active-${Date.now()}`,
  reconnectPeriod: 2000,
  ...tlsOpts,
});

client.on('connect', () => {
  console.log('MQTT connected');
  client.subscribe([activeTopic, statusTopic], { qos: 1 });
  void pushViaServer('on-connect');
});

client.on('message', (topic, msg) => {
  const s = msg.toString();
  if (topic.endsWith('/active')) {
    console.log('saw active on', topic);
    void pushViaServer('after-active');
  }
  if (topic.endsWith('/status') && s.includes('ota')) {
    console.log('OTA STATUS', s);
  }
});

client.on('error', (err) => console.error('MQTT error', err.message));

setTimeout(() => {
  console.log('done');
  client.end();
  process.exit(0);
}, 90000);
