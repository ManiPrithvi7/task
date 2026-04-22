import { CAService } from './src/services/caService';
import * as path from 'path';
import * as fs from 'fs';
import * as forge from 'node-forge';

async function main() {
  const config = {
    storagePath: path.resolve(__dirname, 'src/certs'),
    rootCAValidityYears: 10,
    deviceCertValidityDays: 3650
  };

  const caService = new CAService(config);
  await caService.initialize();

  // Generate client key
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const clientKeyPem = forge.pki.privateKeyToPem(keys.privateKey);

  // Generate CSR
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([
    { name: 'commonName', value: 'PROOF-proof-server' }
  ]);
  csr.sign(keys.privateKey);
  const csrPem = forge.pki.certificationRequestToPem(csr);

  // Sign CSR using CAService to get proper v3 extensions!
  const deviceCert = await caService.signCSR(csrPem, 'proof-server', '000000000000000000000000');
  const clientCrtPem = deviceCert.certificate;

  // Local broker configuration was removed from this repo; write outputs under data/ for convenience.
  const outDir = path.resolve(__dirname, 'data', 'mqtt-client');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'client.key'), clientKeyPem);
  fs.writeFileSync(path.join(outDir, 'client.crt'), clientCrtPem);

  console.log('Successfully generated proper client certificate with extensions.');

  const rootCA = fs.readFileSync('src/certs/root-ca.crt', 'utf8');

  console.log('\nUPDATE YOUR .env WITH THESE BASE64 VARS FOR THE NODE SERVER:');
  console.log('=============================================================');
  console.log('MQTT_TLS_CA_BASE64=' + Buffer.from(rootCA).toString('base64'));
  console.log('MQTT_TLS_CLIENT_CERT_BASE64=' + Buffer.from(clientCrtPem).toString('base64'));
  console.log('MQTT_TLS_CLIENT_KEY_BASE64=' + Buffer.from(clientKeyPem).toString('base64'));
}

main().catch(console.error);
