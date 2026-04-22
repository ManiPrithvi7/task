import * as fs from 'fs';
import * as path from 'path';
import * as forge from 'node-forge';
import { CAService } from '../src/services/caService';

type PemBundle = { certPem: string; keyPem: string };

function mkdirp(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function writeFile(p: string, contents: string, mode: number) {
  fs.writeFileSync(p, contents, { encoding: 'utf8', mode });
}

function backupIfExists(p: string) {
  if (!fs.existsSync(p)) return;
  const dir = path.dirname(p);
  const base = path.basename(p);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = path.join(dir, `${base}.bak-${stamp}`);
  fs.renameSync(p, bak);
}

function generateRsaKeyPair(): forge.pki.rsa.KeyPair {
  return forge.pki.rsa.generateKeyPair(2048);
}

function makeCsr(commonName: string, keys: forge.pki.rsa.KeyPair): string {
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: 'commonName', value: commonName }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificationRequestToPem(csr);
}

async function signWithProfile(opts: {
  caStoragePath: string;
  rootCAValidityYears: number;
  deviceCertValidityDays: number;
  certProfile: NonNullable<ConstructorParameters<typeof CAService>[0]['certProfile']>;
  csrPem: string;
  deviceId: string;
}): Promise<string> {
  const ca = new CAService({
    storagePath: opts.caStoragePath,
    rootCAValidityYears: opts.rootCAValidityYears,
    deviceCertValidityDays: opts.deviceCertValidityDays,
    certProfile: opts.certProfile
  });
  await ca.initialize();
  // userId is stored for audit only; for broker/app client certs we use a stable dummy ObjectId.
  const doc = await ca.signCSR(opts.csrPem, opts.deviceId, '000000000000000000000000');
  return doc.certificate;
}

function toBase64(pem: string): string {
  return Buffer.from(pem, 'utf8').toString('base64');
}

async function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const caStoragePath = path.resolve(repoRoot, 'src/certs');
  // Local broker configuration was removed from this repo; keep outputs under data/.
  const outDir = path.resolve(repoRoot, 'data', 'pki');

  const rootCaCertPath = path.join(caStoragePath, 'root-ca.crt');
  const rootCaKeyPath = path.join(caStoragePath, 'root-ca.key');

  console.log('[pki] Rotating Root CA and generating app client cert...');
  mkdirp(caStoragePath);
  mkdirp(outDir);

  // Backup previous CA (rotation is disruptive; this makes rollback possible).
  backupIfExists(rootCaCertPath);
  backupIfExists(rootCaKeyPath);

  // Initialize CAService; since files are gone, it will generate a new Root CA.
  const ca = new CAService({
    storagePath: caStoragePath,
    rootCAValidityYears: 10,
    deviceCertValidityDays: 3650
  });
  await ca.initialize();

  const rootCaPem = fs.readFileSync(rootCaCertPath, 'utf8');
  writeFile(path.join(outDir, 'root-ca.crt'), rootCaPem, 0o644);

  // Generate app/client certificate for the Node server to connect to the broker with mTLS.
  const appKeys = generateRsaKeyPair();
  const appKeyPem = forge.pki.privateKeyToPem(appKeys.privateKey);
  const appDeviceId = 'proof-server';
  const cnPrefix = (process.env.CERT_CN_PREFIX || 'PROOF').trim().replace(/[-_]+$/g, '');
  const appCn = `${cnPrefix}-proof-server`;
  const appCsrPem = makeCsr(appCn, appKeys);
  const appCertPem = await signWithProfile({
    caStoragePath,
    rootCAValidityYears: 10,
    deviceCertValidityDays: 3650,
    certProfile: {
      validityDays: 3650,
      keyUsage: ['digitalSignature', 'keyEncipherment'],
      extendedKeyUsage: ['clientAuth'],
      requireSanDeviceId: true,
      minKeyBits: 2048
    },
    csrPem: appCsrPem,
    deviceId: appDeviceId
  });
  writeFile(path.join(outDir, 'mqtt-client.key'), appKeyPem, 0o600);
  writeFile(path.join(outDir, 'mqtt-client.crt'), appCertPem, 0o644);

  console.log('\n[pki] Generated files:');
  console.log(`  - ${rootCaCertPath}`);
  console.log(`  - ${rootCaKeyPath}`);
  console.log(`  - ${path.join(outDir, 'root-ca.crt')}`);
  console.log(`  - ${path.join(outDir, 'mqtt-client.crt')}`);
  console.log(`  - ${path.join(outDir, 'mqtt-client.key')}`);

  console.log('\n[pki] Node app (Render/Railway): set these env vars (base64 PEM) — path-based MQTT_TLS_*_PATH is not supported:');
  console.log('  MQTT_TLS_CA_BASE64=' + toBase64(rootCaPem));
  console.log('  MQTT_TLS_CLIENT_CERT_BASE64=' + toBase64(appCertPem));
  console.log('  MQTT_TLS_CLIENT_KEY_BASE64=' + toBase64(appKeyPem));
}

main().catch((err) => {
  console.error('[pki] ERROR:', err);
  process.exit(1);
});

