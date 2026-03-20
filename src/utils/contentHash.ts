import { createHash } from 'crypto';

/**
 * Canonicalizes a JSON payload (sorted keys, no extra whitespace)
 * and returns its SHA-256 hex digest.
 *
 * Returns null if the payload cannot be parsed as JSON.
 * Callers must treat null as a soft failure — log and continue.
 *
 * NOTE: This hash is computed over the canonicalized representation,
 * not the raw wire bytes. It proves what structured content was received,
 * not the exact byte sequence. Device-side signing (Phase 2) is required
 * to eliminate the server-side injection argument entirely.
 */
export function canonicalizeAndHash(payload: Buffer): string | null {
  try {
    const parsed = JSON.parse(payload.toString('utf8'));

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // Only hash keyed objects — arrays and primitives are not canonicalizable
      // in a key-sorted sense. Treat as unparseable for audit purposes.
      return null;
    }

    const canonical = JSON.stringify(parsed, Object.keys(parsed).sort());
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  } catch {
    return null;
  }
}

