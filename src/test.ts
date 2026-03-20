import assert from 'assert';
import * as fs from 'fs';

import * as forge from 'node-forge';
import { TransparencyLog } from './services/transparencyLog';
import { AuditEventType, createAuditService } from './services/auditService';
import { CAService } from './services/caService';
import { createInfluxService } from './services/influxService';

async function main(): Promise<void> {
  // Enum presence checks (guards against accidental rename/removal).
  assert.strictEqual(AuditEventType.CERTIFICATE_ISSUED_IN_MEMORY, 'CERTIFICATE_ISSUED_IN_MEMORY');
  assert.strictEqual(AuditEventType.CERTIFICATE_REPLACED, 'CERTIFICATE_REPLACED');
  assert.strictEqual(AuditEventType.TRANSPARENCY_ENTRY_FAILED, 'TRANSPARENCY_ENTRY_FAILED');

  // CT disabled: addEntry must short-circuit safely.
  const ctDisabled = new TransparencyLog({ enabled: false });
  const disabledResult = await ctDisabled.addEntry('fp', 'sn', 'cn', 'dev');
  assert.strictEqual(disabledResult, null);

  // CT enabled but incomplete identity inputs: guard should prevent partial leaf writes.
  const ctEnabled = new TransparencyLog({ enabled: true });
  const guardResult = await ctEnabled.addEntry('', 'sn', 'cn', 'dev', new Date());
  assert.strictEqual(guardResult, null);

  // Regression check: AuditService.verifyChain should not throw when Influx is unavailable.
  const auditService = createAuditService({
    fallbackLogPath: '/tmp/mqtt-publisher-lite-audit.log',
    hashChainEnabled: true,
    hsmSigningEnabled: false,
    hsmSigningInterval: 100
  });
  const chainResult = await auditService.verifyChain();
  assert.strictEqual(chainResult.valid, false);
  assert.strictEqual(chainResult.checkedCount, 0);

  // Regression check: verifyInclusion should succeed for an in-memory proof.
  const ctLog = new TransparencyLog({ enabled: true });
  const proof = await ctLog.addEntry('fp2', 'sn2', 'cn2', 'dev2', new Date());
  assert.ok(proof);
  if (proof) {
    const included = ctLog.verifyInclusion(proof.leafHash, proof.inclusionProof, proof.rootHash);
    assert.strictEqual(included, true);
  }

  // Targeted regression: verifyChain() should accept new audit event tag values.
  // We mock InfluxDB's queryAuditChain output (no external services required).
  const auditServiceForVerifyChain = createAuditService({
    fallbackLogPath: '/tmp/mqtt-publisher-lite-audit-verifychain.log',
    hashChainEnabled: true,
    hsmSigningEnabled: false,
    hsmSigningInterval: 100
  });

  const influx = createInfluxService({
    enabled: false,
    url: 'http://localhost:8086',
    token: 'dummy',
    org: 'dummy',
    bucket: 'dummy'
  } as any);

  (influx as any).queryAuditChain = async () => ([
    {
      sequence: 1,
      hash: 'h1',
      previousHash: 'GENESIS',
      event: AuditEventType.CERTIFICATE_ISSUED,
      timestamp: new Date().toISOString()
    },
    {
      sequence: 2,
      hash: 'h2',
      previousHash: 'h1',
      event: AuditEventType.CERTIFICATE_ISSUED_IN_MEMORY,
      timestamp: new Date().toISOString()
    },
    {
      sequence: 3,
      hash: 'h3',
      previousHash: 'h2',
      event: AuditEventType.TRANSPARENCY_ENTRY_ADDED,
      timestamp: new Date().toISOString()
    }
  ]);

  const verifyChainResult = await auditServiceForVerifyChain.verifyChain();
  assert.strictEqual(verifyChainResult.valid, true);
  assert.strictEqual(verifyChainResult.checkedCount, 3);

  // Targeted regression: when CT is disabled, issuance should not write TRANSPARENCY_ENTRY_* audit events.
  // We validate via AuditService fallback log file because this smoke test runs without a live InfluxDB.
  const auditLogPath = '/tmp/mqtt-publisher-lite-audit-ct-disabled.log';
  fs.rmSync(auditLogPath, { force: true });

  const auditServiceForCtDisabled = createAuditService({
    fallbackLogPath: auditLogPath,
    hashChainEnabled: true,
    hsmSigningEnabled: false,
    hsmSigningInterval: 100
  });
  await auditServiceForCtDisabled.initialize();

  // Force AuditService fallback-to-file path by making Influx writes fail loudly.
  // (InfluxService.writeAuditEvent() swallows errors, so without this override,
  // AuditService won't fall back and the audit log file won't be created.)
  (influx as any).writeAuditEvent = async () => {
    throw new Error('forced write failure to trigger AuditService fallback');
  };

  const caStoragePath = '/tmp/mqtt-publisher-lite-ca-ct-disabled';
  fs.rmSync(caStoragePath, { force: true, recursive: true });

  process.env.CERT_CN_PREFIX = 'PROOF';
  process.env.CERT_CN_FORMAT = 'legacy';

  const ca = new CAService(
    {
      storagePath: caStoragePath,
      rootCAValidityYears: 1,
      deviceCertValidityDays: 1
    }
  );
  await ca.initialize();

  const deviceId = 'PRESS_0042';
  const userId = '507f1f77bcf86cd799439011'; // valid ObjectId hex string
  const expectedCN = ca.formatExpectedCN(deviceId);

  const keyPair = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keyPair.publicKey;
  csr.setSubject([{ name: 'commonName', value: expectedCN }]);
  csr.sign(keyPair.privateKey, forge.md.sha256.create());
  const csrPem = forge.pki.certificationRequestToPem(csr);

  await ca.signCSR(csrPem, deviceId, userId);

  const auditLogRaw = fs.readFileSync(auditLogPath, { encoding: 'utf8' });
  assert.ok(auditLogRaw.trim().length > 0);
  assert.ok(!auditLogRaw.includes('TRANSPARENCY_ENTRY_ADDED'), 'CT audit should not be recorded when CT is disabled');
  assert.ok(!auditLogRaw.includes('TRANSPARENCY_ENTRY_FAILED'), 'CT audit should not be recorded when CT is disabled');

  // If we got here, the smoke checks passed.
  // eslint-disable-next-line no-console
  console.log('mqtt-publisher-lite smoke tests: OK');
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

