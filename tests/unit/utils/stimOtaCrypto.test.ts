import {
  generateStimLabKeypair,
  signAndVerifyFirmwareBytes,
  verifySha256HexSignature
} from '@/utils/stimOtaCrypto';
import { parseStimFirmwareUpload } from '@/utils/stimFirmwareUploadParse';
import type { Request } from 'express';

describe('stimOtaCrypto', () => {
  it('signs firmware bytes the same way CI does (UTF-8 sha256 hex)', () => {
    const pair = generateStimLabKeypair();
    const bytes = Buffer.from('fake-ino-bin');
    const { sha256, signature } = signAndVerifyFirmwareBytes(bytes, pair);
    expect(sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.from(signature, 'base64').length).toBe(64);
    expect(verifySha256HexSignature(sha256, signature, pair.publicPem)).toBe(true);
    expect(verifySha256HexSignature(sha256, Buffer.alloc(64, 9).toString('base64'), pair.publicPem)).toBe(false);
  });
});

describe('parseStimFirmwareUpload multipart', () => {
  it('reads version field and firmware file', () => {
    const boundary = '----stim';
    const body = [
      `------stim\r\nContent-Disposition: form-data; name="version"\r\n\r\n9.9.9\r\n`,
      `------stim\r\nContent-Disposition: form-data; name="firmware"; filename="app.ino.bin"\r\nContent-Type: application/octet-stream\r\n\r\nBINDATA\r\n`,
      `------stim--\r\n`
    ].join('');
    const req = {
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      query: {}
    } as unknown as Request;
    const parsed = parseStimFirmwareUpload(req, Buffer.from(body));
    expect(parsed.version).toBe('9.9.9');
    expect(parsed.filename).toBe('app.ino.bin');
    expect(parsed.bytes.toString()).toBe('BINDATA');
  });
});
