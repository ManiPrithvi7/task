#!/usr/bin/env node
/**
 * Publish ota_update when the device publishes /active (device is subscribed).
 *
 * Usage:
 *   node scripts/ota-e2e/push-ota-on-active.js <LAN_IP> [DEVICE_ID]
 *
 * Requires proofmqtt/.env with MQTT broker mTLS vars (same creds as server).
 */
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');

const REPO_ROOT = path.resolve(__dirname, '../..');
const envPath = path.join(REPO_ROOT, '.env');
const manifestPath = path.join(__dirname, 'artifacts/manifest.json');

for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (!process.env[m[1]]) process.env[m[1]] = v;
}

function b64(v) {
  return v ? Buffer.from(v, 'base64').toString('utf8') : undefined;
}

if (!fs.existsSync(manifestPath)) {
  console.error('Missing manifest.json — run sign-firmware.sh first');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const lanIp = process.argv[2];
const deviceId = process.argv[3] || 'DEVICE-17';

if (!lanIp) {
  console.error('Usage: node scripts/ota-e2e/push-ota-on-active.js <LAN_IP> [DEVICE_ID]');
  process.exit(1);
}

const topicRoot = process.env.MQTT_TOPIC_ROOT || 'proof.mqtt';
const cmdTopic = `${topicRoot}/${deviceId}/cmd`;
const activeTopic = `${topicRoot}/${deviceId}/active`;
const statusTopic = `${topicRoot}/${deviceId}/status`;
const firmwareFile = process.env.OTA_FIRMWARE_FILE || 'firmware-target.bin';
const port = process.env.OTA_FIRMWARE_PORT || '8765';

const payload = JSON.stringify({
  cmd: 'ota_update',
  version: manifest.version,
  download_url: `http://${lanIp}:${port}/${firmwareFile}`,
  sha256: manifest.sha256,
  signature: manifest.signature,
  size_bytes: manifest.size_bytes,
  force: true,
  issued_at: new Date().toISOString(),
});

const url = `mqtts://${process.env.MQTT_BROKER || 'broker.withproof.io'}:${process.env.MQTT_PORT || 8883}`;
let published = 0;

const client = mqtt.connect(url, {
  clientId: `ota-e2e-${Date.now()}`,
  reconnectPeriod: 2000,
  ca: [b64(process.env.MQTT_TLS_CA_BASE64)],
  cert: b64(process.env.MQTT_TLS_CLIENT_CERT_BASE64),
  key: b64(process.env.MQTT_TLS_CLIENT_KEY_BASE64),
  servername: process.env.MQTT_BROKER || 'broker.withproof.io',
});

function publishOta(reason) {
  if (published >= 5) return;
  published++;
  client.publish(cmdTopic, payload, { qos: 1, retain: false }, (err) => {
    console.log(`${reason}: publish #${published} → ${cmdTopic}`, err || 'OK');
  });
}

client.on('connect', () => {
  console.log('MQTT connected, watching', activeTopic);
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
  console.log('done');
  client.end();
  process.exit(0);
}, 90000);
