/** Browser Origin allowlist for loyalty REST CORS and WSS verifyClient. */

export function isAllowedLoyaltyOrigin(origin: string | undefined): boolean {
  if (!origin) return false;

  const allowList = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowList.includes(origin)) return true;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;

  const host = url.hostname.toLowerCase();
  if (host === 'withproof.io' || host.endsWith('.withproof.io')) return true;

  const pattern = process.env.LOYALTY_PREVIEW_ORIGIN_PATTERN?.trim();
  if (pattern) {
    try {
      const source = pattern.startsWith('^') ? pattern : `^(?:${pattern})$`;
      const anchored = source.endsWith('$') ? source : `${source}$`;
      if (new RegExp(anchored).test(origin)) return true;
    } catch {
      return false;
    }
  }

  return false;
}
