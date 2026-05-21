import type { OAuth2Client } from 'google-auth-library';

const MY_BUSINESS_V4_BASE = 'https://mybusiness.googleapis.com/v4';

export const mapGmbStarRating = (raw: unknown): number => {
  if (typeof raw === 'number' && raw >= 0 && raw <= 5) return raw;
  const map: Record<string, number> = {
    ONE: 1,
    TWO: 2,
    THREE: 3,
    FOUR: 4,
    FIVE: 5,
    STAR_RATING_UNSPECIFIED: 0
  };
  if (typeof raw === 'string' && raw in map) return map[raw] ?? 0;
  return 0;
};

type ListReviewsResponse = {
  reviews?: unknown[];
  nextPageToken?: string;
};

export async function getReview(
  auth: OAuth2Client,
  reviewName: string
): Promise<Record<string, unknown> | null> {
  const name = reviewName.replace(/^\//, '');
  try {
    const res = await auth.request<Record<string, unknown>>({
      url: `${MY_BUSINESS_V4_BASE}/${name}`,
      method: 'GET'
    });
    return res.data ?? null;
  } catch {
    return null;
  }
}

export async function listReviews(
  auth: OAuth2Client,
  locationName: string,
  pageSize = 50,
  maxPages = 1
): Promise<unknown[]> {
  const parent = locationName.replace(/^\//, '');
  const collected: unknown[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  try {
    do {
      pages += 1;
      const res = await auth.request<ListReviewsResponse>({
        url: `${MY_BUSINESS_V4_BASE}/${parent}/reviews`,
        method: 'GET',
        params: {
          pageSize,
          ...(pageToken ? { pageToken } : {})
        }
      });
      const data = res.data;
      if (data?.reviews && Array.isArray(data.reviews)) {
        collected.push(...data.reviews);
      }
      pageToken = data?.nextPageToken ?? undefined;
      if (maxPages > 0 && pages >= maxPages) break;
    } while (pageToken);
  } catch {
    return [];
  }

  return collected;
}
