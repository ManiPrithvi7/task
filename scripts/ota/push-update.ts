#!/usr/bin/env ts-node
/**
 * Push OTA update via proofmqtt server (OCI presigned download_url by default).
 *
 * Usage:
 *   AUTH_TOKEN=<jwt> ts-node scripts/ota/push-update.ts --version 4.3.1-mvp --device DEVICE-17
 *   AUTH_TOKEN=<jwt> ts-node scripts/ota/push-update.ts --version 4.3.1-mvp --broadcast
 *   AUTH_TOKEN=<jwt> ts-node scripts/ota/push-update.ts --version 4.3.1-mvp --device DEVICE-17 --force
 *
 * Reads OTA_API_BASE or PUBLIC_APP_URL from proofmqtt/.env when unset.
 * For push-on-/active behavior, use scripts/ota-e2e/push-ota-on-active.js (same OCI URLs via server).
 */

import * as fs from 'fs';
import * as path from 'path';

function loadEnvFile(): void {
  const envPath = path.resolve(__dirname, '../../.env');
  if (!fs.existsSync(envPath)) return;
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

async function main(): Promise<void> {
  loadEnvFile();

  const args = process.argv.slice(2);
  let version = '';
  let device = '';
  let broadcast = false;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version') version = args[++i] || '';
    if (args[i] === '--device') device = args[++i] || '';
    if (args[i] === '--broadcast') broadcast = true;
    if (args[i] === '--force') force = true;
  }

  const token = process.env.AUTH_TOKEN?.trim();
  const base =
    process.env.OTA_API_BASE?.trim() ||
    process.env.PUBLIC_APP_URL?.trim() ||
    'http://localhost:3002';

  if (!token || !version || (!device && !broadcast)) {
    console.error(
      'Usage: AUTH_TOKEN=... push-update.ts --version X [--device ID | --broadcast] [--force]'
    );
    process.exit(1);
  }

  console.log(`Pushing OTA ${version} via ${base} (download_url = ${process.env.OTA_DOWNLOAD_MODE === 'presigned' ? 'OCI presigned' : 'domain proxy /api/v1/ota/download/:version'})`);

  const res = await fetch(`${base.replace(/\/$/, '')}/api/v1/admin/ota/push`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      version,
      target: broadcast ? 'broadcast' : 'device',
      deviceIds: device ? [device] : undefined,
      force
    })
  });

  const body = await res.json();
  console.log(JSON.stringify(body, null, 2));
  if (!res.ok) process.exit(1);

  console.log('Done. Device should receive download_url from objectstorage.*.oraclecloud.com');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
