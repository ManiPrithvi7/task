/** Returns true when `a` is strictly greater than `b` (semver-like x.y.z). */
export function isVersionGreater(a: string, b: string): boolean {
  const parse = (v: string): number[] =>
    v.split(/[.-]/).map((part) => {
      const n = parseInt(part, 10);
      return Number.isNaN(n) ? 0 : n;
    });

  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}
