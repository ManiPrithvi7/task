import { createHash } from 'crypto';

/** SHA-256 hex digest of a UTF-8 MQTT/screen payload for PKI audit (no encryption). */
export function sha256Payload(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
