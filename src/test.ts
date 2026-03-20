import assert from 'assert';

import { TransparencyLog } from './services/transparencyLog';
import { AuditEventType, createAuditService } from './services/auditService';

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

  // If we got here, the smoke checks passed.
  // eslint-disable-next-line no-console
  console.log('mqtt-publisher-lite smoke tests: OK');
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

