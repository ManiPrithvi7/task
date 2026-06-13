#!/usr/bin/env ts-node
/**
 * Upload a firmware release: init → PUT to OCI (PAR) → finalize.
 *
 * Usage:
 *   AUTH_TOKEN=<jwt> ts-node scripts/ota/upload-release.ts --file ./firmware.bin --version 4.3.1 --sha256 <hex> --signature <b64>
 *
 * Env: OTA_API_BASE (default http://localhost:3002)
 */

import * as fs from 'fs';
import * as path from 'path';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let file = '';
  let version = '';
  let sha256 = '';
  let signature = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file') file = args[++i] || '';
    if (args[i] === '--version') version = args[++i] || '';
    if (args[i] === '--sha256') sha256 = args[++i] || '';
    if (args[i] === '--signature') signature = args[++i] || '';
  }

  const token = process.env.AUTH_TOKEN?.trim();
  const base = process.env.OTA_API_BASE?.trim() || 'http://localhost:3002';

  if (!token || !file || !version || !sha256 || !signature) {
    console.error(
      'Usage: AUTH_TOKEN=... upload-release.ts --file firmware.bin --version 4.3.1 --sha256 <hex> --signature <b64>'
    );
    process.exit(1);
  }

  const initRes = await fetch(`${base}/api/v1/admin/ota/releases/init`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ version })
  });
  const init = (await initRes.json()) as {
    success?: boolean;
    upload_url?: string;
    object_key?: string;
    s3_key?: string;
    error?: string;
  };
  const objectKey = init.object_key || init.s3_key;
  if (!initRes.ok || !init.upload_url || !objectKey) {
    console.error('init failed', init);
    process.exit(1);
  }

  const body = fs.readFileSync(path.resolve(file));
  const putRes = await fetch(init.upload_url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'opc-meta-firmware-version': version,
      'opc-meta-sha256': sha256.toLowerCase()
    },
    body
  });
  if (!putRes.ok) {
    console.error('OCI PUT failed', putRes.status, await putRes.text());
    process.exit(1);
  }

  const finRes = await fetch(`${base}/api/v1/admin/ota/releases/finalize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ version, sha256, signature, object_key: objectKey })
  });
  const fin = await finRes.json();
  console.log(JSON.stringify(fin, null, 2));
  if (!finRes.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
