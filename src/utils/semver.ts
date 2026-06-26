/**
 * Simple semver-ish compare for firmware version strings (e.g. 4.3.1).
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareVersions(a: string, b: string): number {
  const normalize = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split(/[.+_-]/)
      .map((part) => {
        const n = parseInt(part.replace(/\D/g, ''), 10);
        return Number.isFinite(n) ? n : 0;
      });

  const pa = normalize(a);
  const pb = normalize(b);
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

export function isVersionGreater(a: string, b: string): boolean {
  return compareVersions(a, b) > 0;
}
