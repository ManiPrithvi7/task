/** Browser Origin allowlist for loyalty REST CORS and WSS verifyClient. */

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/** RFC1918 IPv4 — phone/LAN Next.js against a local monolith in development. */
function isPrivateLanIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function isDevLikeEnv(): boolean {
  const env = process.env.NODE_ENV;
  return env === 'development' || env === 'test';
}

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
  if (isLoopbackHost(host)) return true;
  if (isDevLikeEnv() && isPrivateLanIPv4(host)) return true;
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
