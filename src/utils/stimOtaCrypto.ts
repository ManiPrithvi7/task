/**
 * Lab stim OTA signing — same contract as scripts/ci-verify.sh / verifyEd25519Signature.
 * SHA-256 of bytes → lowercase hex; Ed25519 over UTF-8 hex; signature base64.
 */

import * as crypto from 'crypto';

export type StimLabKeypair = {
  privatePem: string;
  publicPem: string;
};

export function isProductionNodeEnv(): boolean {
  return (process.env.NODE_ENV?.trim() || 'development') === 'production';
}

export function generateStimLabKeypair(): StimLabKeypair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
  };
}

export function sha256HexOfBytes(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex').toLowerCase();
}

/** Ed25519-sign UTF-8 bytes of the sha256 hex string; return base64. */
export function signSha256Hex(sha256Hex: string, privatePem: string): string {
  const message = Buffer.from(sha256Hex.toLowerCase(), 'utf8');
  const key = crypto.createPrivateKey(privatePem);
  return crypto.sign(null, message, key).toString('base64');
}

export function verifySha256HexSignature(
  sha256Hex: string,
  signatureB64: string,
  publicPem: string
): boolean {
  const message = Buffer.from(sha256Hex.toLowerCase(), 'utf8');
  const pubKey = crypto.createPublicKey(publicPem);
  let sig: Buffer;
  try {
    sig = Buffer.from(signatureB64, 'base64');
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  return crypto.verify(null, message, pubKey, sig);
}

export function signAndVerifyFirmwareBytes(
  bytes: Buffer,
  keypair: StimLabKeypair
): { sha256: string; signature: string } {
  const sha256 = sha256HexOfBytes(bytes);
  const signature = signSha256Hex(sha256, keypair.privatePem);
  if (!verifySha256HexSignature(sha256, signature, keypair.publicPem)) {
    throw new Error('Stim lab Ed25519 self-check failed');
  }
  return { sha256, signature };
}
