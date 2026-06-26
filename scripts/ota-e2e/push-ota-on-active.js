#!/usr/bin/env node
/**
 * Push OTA when the device publishes /active.
 *
 * Default: proofmqtt server admin API (domain proxy or OCI URL per server config).
 *   AUTH_TOKEN=<jwt> node scripts/ota-e2e/push-ota-on-active.js [DEVICE_ID]
 *
 * LAN lab only (direct MQTT + http://LAN:8765):
 *   OTA_E2E_LAN=1 node scripts/ota-e2e/push-ota-on-active.js <LAN_IP> [DEVICE_ID]
 */
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const { createOciDownloadUrl, hasOciEnvCredentials } = require('./oci-download-url');

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

function parseLanArgs(argv) {
  const lanIp = argv[0];
  const deviceId = argv[1] || 'DEVICE-17';
  if (!lanIp) {
    console.error('LAN mode: OTA_E2E_LAN=1 node push-ota-on-active.js <LAN_IP> [DEVICE_ID]');
    process.exit(1);
  }
  if (lanIp.includes('<') || lanIp.includes('>') || !/^\d{1,3}(\.\d{1,3}){3}$/.test(lanIp)) {
    console.error(`Invalid LAN_IP: "${lanIp}"`);
    process.exit(1);
  }
  return { lanIp, deviceId };
}

async function resolveLanDownloadUrl(manifest, lanIp) {
  if (process.env.OTA_E2E_LAN_OCI === '1' || process.env.OTA_E2E_LAN_OCI === 'true') {
    if (!hasOciEnvCredentials()) {
      console.error('OTA_E2E_LAN_OCI requires OCI credentials in .env');
      process.exit(1);
    }
    const { downloadUrl } = await createOciDownloadUrl(manifest.version);
    return downloadUrl;
  }
  const firmwareFile = process.env.OTA_FIRMWARE_FILE || 'firmware-target.bin';
  const port = process.env.OTA_FIRMWARE_PORT || '8765';
  return `http://${lanIp}:${port}/${firmwareFile}`;
}

async function runLanMode(argv) {
  if (!fs.existsSync(manifestPath)) {
    console.error('Missing manifest.json — run sign-firmware.sh first');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const { lanIp, deviceId } = parseLanArgs(argv);
  const downloadUrl = await resolveLanDownloadUrl(manifest, lanIp);

  const topicRoot = process.env.MQTT_TOPIC_ROOT || 'proof.mqtt';
  const cmdTopic = `${topicRoot}/${deviceId}/cmd`;
  const activeTopic = `${topicRoot}/${deviceId}/active`;
  const statusTopic = `${topicRoot}/${deviceId}/status`;
  const payload = JSON.stringify({
    cmd: 'ota_update',
    version: manifest.version,
    download_url: downloadUrl,
    sha256: manifest.sha256,
    signature: manifest.signature,
    size_bytes: manifest.size_bytes,
    force: true,
    issued_at: new Date().toISOString(),
  });

  const url = `mqtts://${process.env.MQTT_BROKER || 'broker.withproof.io'}:${process.env.MQTT_PORT || 8883}`;
  let published = 0;
  const tlsOpts = resolveTlsMaterial();
  const client = mqtt.connect(url, {
    clientId: process.env.OTA_E2E_MQTT_CLIENT_ID || `ota-e2e-pusher-${Date.now()}`,
    reconnectPeriod: 2000,
    ...tlsOpts,
  });

  function publishOta(reason) {
    if (published >= 5) return;
    published++;
    client.publish(cmdTopic, payload, { qos: 1, retain: false }, (err) => {
      console.log(`${reason}: publish #${published} → ${cmdTopic}`, err || 'OK');
    });
  }

  client.on('connect', () => {
    console.log('MQTT connected (LAN mode), watching', activeTopic);
    client.subscribe([activeTopic, statusTopic], { qos: 1 });
    publishOta('on-connect');
  });

  client.on('message', (topic, msg) => {
    const s = msg.toString();
    if (topic.endsWith('/active')) {
      console.log('saw active on', topic);
      publishOta('after-active');
    }
    if (topic.endsWith('/status') && s.includes('ota')) {
      console.log('OTA STATUS', s);
    }
  });

  client.on('error', (err) => console.error('MQTT error', err.message));
  setTimeout(() => {
    client.end();
    process.exit(0);
  }, 90000);
}

async function runServerPushMode(argv) {
  const deviceId = argv[0] || process.env.OTA_DEVICE_ID || 'DEVICE-17';
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
    console.error(`Example: AUTH_TOKEN=<jwt> node scripts/ota-e2e/push-ota-on-active.js ${deviceId}`);
    process.exit(1);
  }
  if (!version) {
    console.error('Set OTA_FIRMWARE_VERSION or create scripts/ota-e2e/artifacts/manifest.json.');
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
    } catch (err) {
      console.error(`${reason}: server push error`, err instanceof Error ? err.message : String(err));
    } finally {
      pushInFlight = false;
    }
  }

  const url = `mqtts://${process.env.MQTT_BROKER || 'broker.withproof.io'}:${process.env.MQTT_PORT || 8883}`;
  const tlsOpts = resolveTlsMaterial();
  console.log(`Watching ${activeTopic} — push OTA ${version} via ${apiBase}`);

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
    client.end();
    process.exit(0);
  }, 90000);
}

const lanMode = process.env.OTA_E2E_LAN === '1' || process.env.OTA_E2E_LAN === 'true';
const argv = process.argv.slice(2);

if (lanMode) {
  runLanMode(argv).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else {
  runServerPushMode(argv).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
