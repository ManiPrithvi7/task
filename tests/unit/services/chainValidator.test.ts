/**
 * chainValidator — P0 path-validation coverage with real node-forge certs.
 */

import * as forge from 'node-forge';
import { isChainValid, validateCertificateChain } from '@/services/chainValidator';

type KeyPair = forge.pki.rsa.KeyPair;

function makeCA(
  cn: string,
  opts: { pathLenConstraint?: number; cA?: boolean; validityDays?: number; notBeforeOffsetMs?: number; notAfterOffsetMs?: number } = {}
): { cert: forge.pki.Certificate; keys: KeyPair; pem: string } {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(8));
  const now = Date.now();
  cert.validity.notBefore = new Date(now + (opts.notBeforeOffsetMs ?? -86_400_000));
  cert.validity.notAfter = new Date(now + (opts.notAfterOffsetMs ?? (opts.validityDays ?? 30) * 86_400_000));
  cert.setSubject([{ name: 'commonName', value: cn }]);
  cert.setIssuer([{ name: 'commonName', value: cn }]);
  const bc: Record<string, unknown> = {
    name: 'basicConstraints',
    cA: opts.cA !== false,
    critical: true
  };
  if (opts.pathLenConstraint !== undefined) {
    bc.pathLenConstraint = opts.pathLenConstraint;
  }
  cert.setExtensions([
    bc,
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true }
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert, keys, pem: forge.pki.certificateToPem(cert) };
}

function signCert(
  cn: string,
  issuer: { cert: forge.pki.Certificate; keys: KeyPair },
  opts: { cA?: boolean; notBeforeOffsetMs?: number; notAfterOffsetMs?: number; pathLenConstraint?: number } = {}
): { cert: forge.pki.Certificate; keys: KeyPair; pem: string } {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '02' + forge.util.bytesToHex(forge.random.getBytesSync(8));
  const now = Date.now();
  cert.validity.notBefore = new Date(now + (opts.notBeforeOffsetMs ?? -86_400_000));
  cert.validity.notAfter = new Date(now + (opts.notAfterOffsetMs ?? 30 * 86_400_000));
  cert.setSubject([{ name: 'commonName', value: cn }]);
  cert.setIssuer(issuer.cert.subject.attributes);
  const extensions: Record<string, unknown>[] = [];
  if (opts.cA) {
    const bc: Record<string, unknown> = { name: 'basicConstraints', cA: true, critical: true };
    if (opts.pathLenConstraint !== undefined) bc.pathLenConstraint = opts.pathLenConstraint;
    extensions.push(bc);
    extensions.push({ name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true });
  } else {
    extensions.push({ name: 'basicConstraints', cA: false });
    extensions.push({ name: 'keyUsage', digitalSignature: true, keyEncipherment: true });
  }
  cert.setExtensions(extensions);
  cert.sign(issuer.keys.privateKey, forge.md.sha256.create());
  return { cert, keys, pem: forge.pki.certificateToPem(cert) };
}

describe('validateCertificateChain', () => {
  it('accepts a valid 2-cert chain (leaf ← root)', () => {
    const root = makeCA('RootCA');
    const leaf = signCert('DeviceLeaf', root);
    const result = validateCertificateChain(leaf.pem, [], root.pem);
    expect(result.valid).toBe(true);
    expect(result.chainLength).toBe(2);
    expect(result.chainSubjects).toEqual(['DeviceLeaf', 'RootCA']);
    expect(result.errors).toEqual([]);
  });

  it('accepts a valid 3-cert chain (leaf ← intermediate ← root)', () => {
    const root = makeCA('RootCA');
    const intermediate = signCert('IntermediateCA', root, { cA: true });
    const leaf = signCert('DeviceLeaf', intermediate);
    const result = validateCertificateChain(leaf.pem, [intermediate.pem], root.pem);
    expect(result.valid).toBe(true);
    expect(result.chainLength).toBe(3);
    expect(result.chainSubjects).toEqual(['DeviceLeaf', 'IntermediateCA', 'RootCA']);
  });

  it('rejects leaf signed by wrong key', () => {
    const root = makeCA('RootCA');
    const other = makeCA('OtherCA');
    const leaf = signCert('DeviceLeaf', other);
    const result = validateCertificateChain(leaf.pem, [], root.pem);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /signature verification (failed|error)/i.test(e))).toBe(true);
  });

  it('rejects root that is not self-signed', () => {
    const realRoot = makeCA('RealRoot');
    // Build a "root" PEM that was signed by another CA (not self-signed)
    const fakeRoot = signCert('FakeRoot', realRoot, { cA: true });
    const leaf = signCert('DeviceLeaf', fakeRoot);
    const result = validateCertificateChain(leaf.pem, [], fakeRoot.pem);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /not self-signed|self-signature check failed/i.test(e))).toBe(true);
  });

  it('rejects expired leaf', () => {
    const root = makeCA('RootCA');
    const leaf = signCert('ExpiredLeaf', root, {
      notBeforeOffsetMs: -10 * 86_400_000,
      notAfterOffsetMs: -86_400_000
    });
    const result = validateCertificateChain(leaf.pem, [], root.pem);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /ExpiredLeaf/.test(e) && /has expired/.test(e))).toBe(true);
  });

  it('rejects not-yet-valid leaf', () => {
    const root = makeCA('RootCA');
    const leaf = signCert('FutureLeaf', root, {
      notBeforeOffsetMs: 86_400_000,
      notAfterOffsetMs: 30 * 86_400_000
    });
    const result = validateCertificateChain(leaf.pem, [], root.pem);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /FutureLeaf/.test(e) && /not yet valid/.test(e))).toBe(true);
  });

  it('rejects intermediate without cA=true', () => {
    const root = makeCA('RootCA');
    const badIntermediate = signCert('NotACA', root, { cA: false });
    const leaf = signCert('DeviceLeaf', badIntermediate);
    const result = validateCertificateChain(leaf.pem, [badIntermediate.pem], root.pem);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /NotACA/.test(e) && /basicConstraints\.cA=true/.test(e))).toBe(true);
  });

  it('rejects leaf with cA=true', () => {
    const root = makeCA('RootCA');
    const leaf = signCert('LeafCA', root, { cA: true });
    const result = validateCertificateChain(leaf.pem, [], root.pem);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /Leaf certificate "LeafCA".*cA=true/.test(e))).toBe(true);
  });

  it('returns parse error for garbage PEM without throwing', () => {
    const result = validateCertificateChain('not-a-pem', [], 'also-not-a-pem');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /Chain validation error:/.test(e))).toBe(true);
  });
});

describe('isChainValid', () => {
  it('wraps validateCertificateChain.valid', () => {
    const root = makeCA('RootCA');
    const leaf = signCert('DeviceLeaf', root);
    expect(isChainValid(leaf.pem, [], root.pem)).toBe(true);
    expect(isChainValid('bad', [], root.pem)).toBe(false);
  });
});
