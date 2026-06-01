/**
 * Unified PKI CLI — Root CA + Proof app MQTT client cert (CAService).
 * Broker server certs: use OpenSSL scripts in this directory (generate-broker-cert.sh).
 *
 * Usage:
 *   npm run pki -- init-ca
 *   npm run pki -- app-client
 *   npm run pki -- rotate
 *   npm run pki -- print-app-env
 */
import * as fs from 'fs';
import * as path from 'path';
import * as forge from 'node-forge';
import { CAService } from '../../src/services/caService';

const repoRoot = path.resolve(__dirname, '../..');
const caStoragePath = path.resolve(repoRoot, process.env.PKI_CA_DIR || 'data/ca');
const appClientDir = path.resolve(repoRoot, process.env.PKI_APP_CLIENT_DIR || 'data/mqtt-client');

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
  fs.renameSync(p, path.join(dir, `${base}.bak-${stamp}`));
}

function toBase64(pem: string): string {
  return Buffer.from(pem, 'utf8').toString('base64');
}

function caConfig() {
  return {
    storagePath: caStoragePath,
    rootCAValidityYears: 10,
    deviceCertValidityDays: 3650
  };
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

async function signAppClientCert(): Promise<{ certPem: string; keyPem: string; cn: string }> {
  const appKeys = generateRsaKeyPair();
  const keyPem = forge.pki.privateKeyToPem(appKeys.privateKey);
  const deviceId = process.env.PKI_APP_DEVICE_ID || 'proof-server';
  const cnPrefix = (process.env.CERT_CN_PREFIX || 'PROOF').trim().replace(/[-_]+$/g, '');
  const cn = `${cnPrefix}-${deviceId}`;

  const ca = new CAService({
    ...caConfig(),
    certProfile: {
      validityDays: 3650,
      keyUsage: ['digitalSignature', 'keyEncipherment'],
      extendedKeyUsage: ['clientAuth'],
      requireSanDeviceId: true,
      minKeyBits: 2048
    }
  });
  await ca.initialize();

  const csrPem = makeCsr(cn, appKeys);
  const doc = await ca.signCSR(csrPem, deviceId, '000000000000000000000000');

  return { certPem: doc.certificate, keyPem, cn };
}

async function cmdInitCa(): Promise<void> {
  console.log('[pki] init-ca — ensure Root CA exists under', caStoragePath);
  mkdirp(caStoragePath);
  const ca = new CAService(caConfig());
  await ca.initialize();
  console.log('[pki] Root CA ready:', path.join(caStoragePath, 'root-ca.crt'));
  console.log('[pki] Next: npm run pki -- app-client  (or generate broker cert via ./scripts/pki/generate-broker-cert.sh)');
}

async function cmdAppClient(): Promise<void> {
  console.log('[pki] app-client — issue Proof server MQTT client cert');
  mkdirp(appClientDir);
  const { certPem, keyPem, cn } = await signAppClientCert();
  writeFile(path.join(appClientDir, 'client.crt'), certPem, 0o644);
  writeFile(path.join(appClientDir, 'client.key'), keyPem, 0o600);
  console.log('[pki] Wrote', path.join(appClientDir, 'client.crt'));
  console.log('[pki] Wrote', path.join(appClientDir, 'client.key'));
  console.log('[pki] CN:', cn);
  await cmdPrintAppEnv();
}

async function cmdRotate(): Promise<void> {
  console.log('[pki] rotate — WARNING: new Root CA requires re-provisioning all devices');
  mkdirp(caStoragePath);
  mkdirp(appClientDir);

  backupIfExists(path.join(caStoragePath, 'root-ca.crt'));
  backupIfExists(path.join(caStoragePath, 'root-ca.key'));

  const ca = new CAService(caConfig());
  await ca.initialize();

  const { certPem, keyPem } = await signAppClientCert();
  writeFile(path.join(appClientDir, 'client.crt'), certPem, 0o644);
  writeFile(path.join(appClientDir, 'client.key'), keyPem, 0o600);

  console.log('[pki] Rotation complete. Update MQTT_TLS_* base64 vars below and redeploy NanoMQ trust if CA changed.');
  await cmdPrintAppEnv();
}

async function cmdPrintAppEnv(): Promise<void> {
  const caCertPath = path.join(caStoragePath, 'root-ca.crt');
  const caKeyPath = path.join(caStoragePath, 'root-ca.key');
  const clientCertPath = path.join(appClientDir, 'client.crt');
  const clientKeyPath = path.join(appClientDir, 'client.key');

  for (const p of [caCertPath, clientCertPath, clientKeyPath]) {
    if (!fs.existsSync(p)) {
      throw new Error(`Missing ${p} — run: npm run pki -- init-ca && npm run pki -- app-client`);
    }
  }

  const rootCaPem = fs.readFileSync(caCertPath, 'utf8');
  const clientCertPem = fs.readFileSync(clientCertPath, 'utf8');
  const clientKeyPem = fs.readFileSync(clientKeyPath, 'utf8');

  console.log('\n[pki] Proof app env (base64 PEM — paste into Railway / .env):');
  console.log('MQTT_TLS_CA_BASE64=' + toBase64(rootCaPem));
  if (fs.existsSync(caKeyPath)) {
    const rootCaKeyPem = fs.readFileSync(caKeyPath, 'utf8');
    console.log('MQTT_TLS_CA_KEY_BASE64=' + toBase64(rootCaKeyPem));
  }
  console.log('MQTT_TLS_CLIENT_CERT_BASE64=' + toBase64(clientCertPem));
  console.log('MQTT_TLS_CLIENT_KEY_BASE64=' + toBase64(clientKeyPem));
}

function usage(): never {
  console.log(`Usage: npm run pki -- <command>

Commands:
  init-ca        Create or load Root CA in ${caStoragePath}
  app-client     Issue Proof server MQTT client cert (CAService profile)
  rotate         Rotate Root CA + new app client cert (disruptive)
  print-app-env  Print MQTT_TLS_*_BASE64 from data/ca + data/mqtt-client

Broker server cert (OpenSSL, separate):
  ./scripts/pki/generate-broker-cert.sh
  ./scripts/pki/print-railway-broker-env.sh
  ./scripts/pki/verify-broker-tls.sh --compare-both   # broker.withproof.io:8883 + proxy:12359
`);
  process.exit(1);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'init-ca':
      await cmdInitCa();
      break;
    case 'app-client':
      await cmdAppClient();
      break;
    case 'rotate':
      await cmdRotate();
      break;
    case 'print-app-env':
      await cmdPrintAppEnv();
      break;
    default:
      usage();
  }
}

main().catch((err) => {
  console.error('[pki] ERROR:', err instanceof Error ? err.message : err);
  process.exit(1);
});
