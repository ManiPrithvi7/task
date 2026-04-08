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
  const caStoragePath = path.resolve(repoRoot, 'data/ca');
  const brokerCertDir = path.resolve(repoRoot, 'broker/certs');

  const rootCaCertPath = path.join(caStoragePath, 'root-ca.crt');
  const rootCaKeyPath = path.join(caStoragePath, 'root-ca.key');

  console.log('[pki] Rotating Root CA and broker/app TLS certs...');
  mkdirp(caStoragePath);
  mkdirp(brokerCertDir);

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
  writeFile(path.join(brokerCertDir, 'root_ca.crt'), rootCaPem, 0o644);

  // 1) Generate broker server cert (must include serverAuth).
  const brokerKeys = generateRsaKeyPair();
  const brokerKeyPem = forge.pki.privateKeyToPem(brokerKeys.privateKey);
  const brokerDeviceId = process.env.NANOMQ_BROKER_NAME?.trim() || 'nanomq-broker';
  const brokerCnPrefix = (process.env.CERT_CN_PREFIX || 'PROOF').trim().replace(/[-_]+$/g, '');
  const brokerCn = `${brokerCnPrefix}-${brokerDeviceId.replace(new RegExp(`^${brokerCnPrefix}[-_]*`), '')}`;
  const brokerCsrPem = makeCsr(brokerCn, brokerKeys);
  const brokerCertPem = await signWithProfile({
    caStoragePath,
    rootCAValidityYears: 10,
    deviceCertValidityDays: 3650,
    certProfile: {
      validityDays: 3650,
      keyUsage: ['digitalSignature', 'keyEncipherment'],
      extendedKeyUsage: ['serverAuth', 'clientAuth'],
      requireSanDeviceId: true,
      minKeyBits: 2048
    },
    csrPem: brokerCsrPem,
    deviceId: brokerDeviceId
  });
  writeFile(path.join(brokerCertDir, 'broker.key'), brokerKeyPem, 0o600);
  writeFile(path.join(brokerCertDir, 'broker.crt'), brokerCertPem, 0o644);

  // 2) Generate app/client certificate for the Node server to connect to the broker with mTLS.
  const appKeys = generateRsaKeyPair();
  const appKeyPem = forge.pki.privateKeyToPem(appKeys.privateKey);
  const appDeviceId = 'proof-server';
  const appCn = `${brokerCnPrefix}-proof-server`;
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
  writeFile(path.join(brokerCertDir, 'client.key'), appKeyPem, 0o600);
  writeFile(path.join(brokerCertDir, 'client.crt'), appCertPem, 0o644);

  console.log('\n[pki] Generated files:');
  console.log(`  - ${rootCaCertPath}`);
  console.log(`  - ${rootCaKeyPath}`);
  console.log(`  - ${path.join(brokerCertDir, 'root_ca.crt')}`);
  console.log(`  - ${path.join(brokerCertDir, 'broker.crt')}`);
  console.log(`  - ${path.join(brokerCertDir, 'broker.key')}`);
  console.log(`  - ${path.join(brokerCertDir, 'client.crt')}`);
  console.log(`  - ${path.join(brokerCertDir, 'client.key')}`);

  console.log('\n[pki] Broker env (NANOMQ_TLS_* expect full PEM text):');
  console.log('  NANOMQ_TLS_CA_CERT=' + JSON.stringify(rootCaPem));
  console.log('  NANOMQ_TLS_CERT=' + JSON.stringify(brokerCertPem));
  console.log('  NANOMQ_TLS_KEY=' + JSON.stringify(brokerKeyPem));

  console.log('\n[pki] App env (base64) — if you prefer env over files:');
  console.log('  MQTT_TLS_CA_BASE64=' + toBase64(rootCaPem));
  console.log('  MQTT_TLS_CLIENT_CERT_BASE64=' + toBase64(appCertPem));
  console.log('  MQTT_TLS_CLIENT_KEY_BASE64=' + toBase64(appKeyPem));

  console.log('\n[pki] Recommended local .env (file paths) for the Node server:');
  console.log(`  MQTT_TLS_CA_PATH=${path.join(brokerCertDir, 'root_ca.crt')}`);
  console.log(`  MQTT_TLS_CLIENT_CERT_PATH=${path.join(brokerCertDir, 'client.crt')}`);
  console.log(`  MQTT_TLS_CLIENT_KEY_PATH=${path.join(brokerCertDir, 'client.key')}`);
}

main().catch((err) => {
  console.error('[pki] ERROR:', err);
  process.exit(1);
});

