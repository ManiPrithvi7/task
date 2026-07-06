import { createHash } from 'crypto';
import { ig } from './integrations';

export const IG_PROFILE_API_ENDPOINT = 'graph.instagram.com/me';

export type InstagramProfileMetrics = {
  followers_count: number;
  media_count: number;
  username?: string;
};

export type InstagramProfileFetchAudit = {
  apiEndpoint: string;
  primaryResponseSha256: string;
  httpStatus: number;
  detailsResponseSha256?: string;
};

export type InstagramProfileFetchResult = {
  metrics: InstagramProfileMetrics;
  audit: InstagramProfileFetchAudit;
};

export class InstagramProfileFetchError extends Error {
  httpStatus?: number;
  retryAfterSeconds?: number;
  code?: number | string;
  primaryResponseSha256?: string;
  apiEndpoint?: string;

  constructor(message: string, opts?: {
    httpStatus?: number;
    retryAfterSeconds?: number;
    code?: number | string;
    primaryResponseSha256?: string;
    apiEndpoint?: string;
  }) {
    super(message);
    this.name = 'InstagramProfileFetchError';
    this.httpStatus = opts?.httpStatus;
    this.retryAfterSeconds = opts?.retryAfterSeconds;
    this.code = opts?.code;
    this.primaryResponseSha256 = opts?.primaryResponseSha256;
    this.apiEndpoint = opts?.apiEndpoint;
  }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Fetches Instagram profile metrics via proof-socials Graph helpers.
 * Surfaces HTTP 429 and Graph error codes for proofmqtt retry/circuit logic.
 * Computes response SHA256 at fetch time for compliance audit (before any transform).
 */
export async function fetchInstagramProfileMetrics(
  accessToken: string
): Promise<InstagramProfileFetchResult | null> {
  const apiEndpoint = IG_PROFILE_API_ENDPOINT;
  const url = `https://${apiEndpoint}?fields=followers_count,media_count&access_token=${encodeURIComponent(accessToken)}`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(15_000) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new InstagramProfileFetchError(`Instagram API request failed: ${msg}`, { apiEndpoint });
  }

  if (res.status === 429) {
    const rawRa = res.headers.get('retry-after');
    let retryAfterSeconds = 60;
    if (rawRa) {
      const n = parseInt(String(rawRa), 10);
      if (Number.isFinite(n) && n > 0) retryAfterSeconds = n;
    }
    throw new InstagramProfileFetchError('HTTP 429 Too Many Requests', {
      httpStatus: 429,
      retryAfterSeconds,
      apiEndpoint
    });
  }

  const text = await res.text();
  const primaryResponseSha256 = sha256Hex(text);
  const httpStatus = res.status;

  let parsed: Record<string, unknown> = {};
  try {
    parsed = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
  } catch {
    throw new InstagramProfileFetchError(
      `Failed to parse Instagram API response (${res.status}): ${text.slice(0, 200)}`,
      { httpStatus, primaryResponseSha256, apiEndpoint }
    );
  }

  if (!res.ok) {
    if (parsed.error && typeof parsed.error === 'object') {
      const ge = parsed.error as { message?: string; code?: number; type?: string };
      throw new InstagramProfileFetchError(ge.message || 'Instagram API error', {
        code: ge.code,
        httpStatus,
        primaryResponseSha256,
        apiEndpoint
      });
    }
    return null;
  }

  const followerRaw = parsed.followers_count;
  const mediaRaw = parsed.media_count;
  const followers_count =
    typeof followerRaw === 'number' && Number.isFinite(followerRaw) ? followerRaw : null;
  if (followers_count === null) return null;

  const media_count =
    typeof mediaRaw === 'number' && Number.isFinite(mediaRaw) ? mediaRaw : 0;

  const details = await ig.getInstagramUserDetails(accessToken);
  const detailsResponseSha256 =
    details != null ? sha256Hex(JSON.stringify(details)) : undefined;
  const username =
    details && typeof details.username === 'string' && details.username.trim()
      ? details.username.trim()
      : undefined;

  return {
    metrics: {
      followers_count,
      media_count,
      ...(username ? { username } : {})
    },
    audit: {
      apiEndpoint,
      primaryResponseSha256,
      httpStatus,
      ...(detailsResponseSha256 ? { detailsResponseSha256 } : {})
    }
  };
}
