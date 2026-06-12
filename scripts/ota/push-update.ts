#!/usr/bin/env ts-node
/**
 * Push OTA update to device(s) or broadcast.
 *
 * Usage:
 *   AUTH_TOKEN=<jwt> ts-node scripts/ota/push-update.ts --version 4.3.1 --device DEVICE-01
 *   AUTH_TOKEN=<jwt> ts-node scripts/ota/push-update.ts --version 4.3.1 --broadcast
 */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let version = '';
  let device = '';
  let broadcast = false;
  let mode: 'full' | 'trigger' = 'full';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version') version = args[++i] || '';
    if (args[i] === '--device') device = args[++i] || '';
    if (args[i] === '--broadcast') broadcast = true;
    if (args[i] === '--trigger') mode = 'trigger';
  }

  const token = process.env.AUTH_TOKEN?.trim();
  const base = process.env.OTA_API_BASE?.trim() || 'http://localhost:3002';

  if (!token || !version || (!device && !broadcast)) {
    console.error(
      'Usage: AUTH_TOKEN=... push-update.ts --version X [--device ID | --broadcast] [--trigger]'
    );
    process.exit(1);
  }

  const res = await fetch(`${base}/api/v1/admin/ota/push`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      version,
      target: broadcast ? 'broadcast' : 'device',
      mode,
      deviceIds: device ? [device] : undefined
    })
  });

  const body = await res.json();
  console.log(JSON.stringify(body, null, 2));
  if (!res.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
