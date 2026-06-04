import { ig } from './integrations';

export type InstagramProfileMetrics = {
  followers_count: number;
  media_count: number;
  username?: string;
};

export class InstagramProfileFetchError extends Error {
  httpStatus?: number;
  retryAfterSeconds?: number;
  code?: number | string;

  constructor(message: string, opts?: { httpStatus?: number; retryAfterSeconds?: number; code?: number | string }) {
    super(message);
    this.name = 'InstagramProfileFetchError';
    this.httpStatus = opts?.httpStatus;
    this.retryAfterSeconds = opts?.retryAfterSeconds;
    this.code = opts?.code;
  }
}

/**
 * Fetches Instagram profile metrics via proof-socials Graph helpers.
 * Surfaces HTTP 429 and Graph error codes for proofmqtt retry/circuit logic.
 */
export async function fetchInstagramProfileMetrics(
  accessToken: string
): Promise<InstagramProfileMetrics | null> {
  const url = `https://graph.instagram.com/me?fields=followers_count,media_count&access_token=${encodeURIComponent(accessToken)}`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(15_000) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new InstagramProfileFetchError(`Instagram API request failed: ${msg}`);
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
      retryAfterSeconds
    });
  }

  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
  } catch {
    throw new InstagramProfileFetchError(
      `Failed to parse Instagram API response (${res.status}): ${text.slice(0, 200)}`
    );
  }

  if (!res.ok) {
    if (parsed.error && typeof parsed.error === 'object') {
      const ge = parsed.error as { message?: string; code?: number; type?: string };
      throw new InstagramProfileFetchError(ge.message || 'Instagram API error', { code: ge.code });
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
  const username =
    details && typeof details.username === 'string' && details.username.trim()
      ? details.username.trim()
      : undefined;

  return {
    followers_count,
    media_count,
    ...(username ? { username } : {})
  };
}
