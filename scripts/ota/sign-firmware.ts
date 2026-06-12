#!/usr/bin/env ts-node
/**
 * Sign firmware release metadata (placeholder — align payload with firmware team).
 *
 * Usage: ts-node scripts/ota/sign-firmware.ts --version 4.3.1 --sha256 <hex>
 *
 * Requires OTA_ED25519_PRIVATE_KEY_PATH (PEM) for signing.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';

function parseArgs(): { version: string; sha256: string } {
  const args = process.argv.slice(2);
  let version = '';
  let sha256 = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version') version = args[++i] || '';
    if (args[i] === '--sha256') sha256 = args[++i] || '';
  }
  if (!version || !sha256) {
    console.error('Usage: sign-firmware.ts --version X --sha256 <64 hex>');
    process.exit(1);
  }
  return { version, sha256: sha256.toLowerCase() };
}

function main(): void {
  const { version, sha256 } = parseArgs();
  const keyPath = process.env.OTA_ED25519_PRIVATE_KEY_PATH?.trim();
  if (!keyPath || !fs.existsSync(keyPath)) {
    console.error('Set OTA_ED25519_PRIVATE_KEY_PATH to an Ed25519 private key PEM');
    process.exit(1);
  }

  // Default placeholder: sign SHA-256 hex string (confirm with firmware team)
  const message = Buffer.from(sha256, 'utf8');
  const keyPem = fs.readFileSync(keyPath, 'utf8');
  const key = crypto.createPrivateKey(keyPem);
  const signature = crypto.sign(null, message, key).toString('base64');

  console.log(JSON.stringify({ version, sha256, signature }, null, 2));
}

main();
