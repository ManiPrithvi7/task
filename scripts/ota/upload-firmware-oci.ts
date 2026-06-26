#!/usr/bin/env ts-node
/**
 * Upload firmware to OCI Object Storage using env-based API key auth
 * (same vars as proofmqtt server — no ~/.oci/config or browser session).
 *
 * Usage:
 *   npx ts-node scripts/ota/upload-firmware-oci.ts \
 *     --file /path/to/wifi_ap_project.bin \
 *     --version 4.3.1-mvp
 *
 * Env: OCI_TENANCY_OCID, OCI_USER_OCID, OCI_FINGERPRINT,
 *      OCI_API_PRIVATE_KEY or OCI_API_PRIVATE_KEY_BASE64,
 *      optional OTA_OCI_NAMESPACE / OTA_OCI_BUCKET / OTA_OCI_REGION
 */

import 'dotenv/config';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { objectstorage } from 'oci-sdk';
import { loadConfig } from '../../src/config';
import {
  FIRMWARE_SHA256_METADATA_KEY,
  FIRMWARE_VERSION_METADATA_KEY
} from '../../src/services/firmwareStorageService';
import { createOciAuthProvider } from '../../src/services/ociAuthProvider';
import { createFirmwareStorageService } from '../../src/services/firmwareStorageService';

function parseArgs(): { file: string; version: string; sha256?: string; objectKey?: string } {
  const args = process.argv.slice(2);
  let file = '';
  let version = '';
  let sha256 = '';
  let objectKey = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file') file = args[++i] || '';
    if (args[i] === '--version') version = args[++i] || '';
    if (args[i] === '--sha256') sha256 = args[++i] || '';
    if (args[i] === '--object-key') objectKey = args[++i] || '';
  }

  if (!file || !version) {
    console.error(
      'Usage: upload-firmware-oci.ts --file firmware.bin --version 4.3.1-mvp [--sha256 hex] [--object-key key]'
    );
    process.exit(1);
  }

  return {
    file,
    version,
    sha256: sha256 || undefined,
    objectKey: objectKey || undefined
  };
}

function sha256Hex(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

async function main(): Promise<void> {
  const { file, version, sha256: sha256Arg, objectKey: objectKeyArg } = parseArgs();
  const filePath = path.resolve(file);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const config = loadConfig();
  if (!config.ota?.enabled || !config.ota.oci.credentials) {
    console.error(
      'OTA not configured: set OTA_ENABLED=true and OCI_TENANCY_OCID, OCI_USER_OCID, OCI_FINGERPRINT, OCI_API_PRIVATE_KEY(_BASE64)'
    );
    process.exit(1);
  }

  const sha256 = sha256Arg || sha256Hex(filePath);
  const storage = createFirmwareStorageService(config.ota);
  const objectKey = objectKeyArg || storage.buildObjectKey(version);
  const sizeBytes = fs.statSync(filePath).size;
  const provider = createOciAuthProvider(config.ota.oci);
  const client = new objectstorage.ObjectStorageClient({
    authenticationDetailsProvider: provider
  });
  client.regionId = config.ota.oci.region;

  await client.putObject({
    namespaceName: config.ota.oci.namespace,
    bucketName: config.ota.oci.bucket,
    objectName: objectKey,
    putObjectBody: fs.createReadStream(filePath),
    contentLength: sizeBytes,
    contentType: 'application/octet-stream',
    opcMeta: {
      [FIRMWARE_VERSION_METADATA_KEY]: version,
      [FIRMWARE_SHA256_METADATA_KEY]: sha256.toLowerCase()
    }
  });

  const head = await storage.headObject(objectKey);
  console.log(
    JSON.stringify(
      {
        ok: true,
        bucket: config.ota.oci.bucket,
        namespace: config.ota.oci.namespace,
        region: config.ota.oci.region,
        object_key: objectKey,
        version,
        sha256: sha256.toLowerCase(),
        size_bytes: head.sizeBytes
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
