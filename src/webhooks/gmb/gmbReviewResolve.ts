import type { OAuth2Client } from 'google-auth-library';
import { getReview, listReviews, mapGmbStarRating } from '../../services/googleBusiness/googleBusinessApi';
import {
  buildReviewFromNotification,
  isGmbTestNotification,
  resolveGmbLocationResourceName,
  resolveGmbReviewResourceName,
  type GmbReviewNotification
} from '../types/gmbReviewNotification';

export type GmbReviewPayload = {
  name: string;
  starRating: number | string;
  comment: string | null;
  reviewer: { displayName: string };
  createTime: string;
  updateTime: string;
};

type RawReview = {
  name?: string;
  starRating?: number | string;
  comment?: string;
  reviewer?: { displayName?: string };
  createTime?: string;
  updateTime?: string;
};

const normalizeRawReview = (raw: RawReview): GmbReviewPayload | null => {
  if (!raw.name) return null;
  const createTime = raw.createTime ?? new Date().toISOString();
  return {
    name: raw.name,
    starRating: raw.starRating ?? 'STAR_RATING_UNSPECIFIED',
    comment: raw.comment ?? null,
    reviewer: { displayName: raw.reviewer?.displayName ?? 'Anonymous' },
    createTime,
    updateTime: raw.updateTime ?? createTime
  };
};

const extractReviewIdSuffix = (resourceName: string): string => {
  const idx = resourceName.lastIndexOf('/reviews/');
  if (idx >= 0) return resourceName.slice(idx + '/reviews/'.length);
  return resourceName.replace(/^.*\//, '');
};

export const mapReviewPayloadToStorage = (review: GmbReviewPayload) => ({
  reviewId: review.name,
  starRating: mapGmbStarRating(review.starRating),
  comment: review.comment,
  reviewerName: review.reviewer.displayName,
  createTime: new Date(review.createTime),
  updateTime: new Date(review.updateTime)
});

export async function resolveGmbReviewPayload(
  oauth2Client: OAuth2Client,
  notification: GmbReviewNotification,
  locationResourceName?: string
): Promise<GmbReviewPayload | null> {
  if (!notification.account || !notification.location || !notification.review) {
    return null;
  }

  if (isGmbTestNotification(notification)) {
    return buildReviewFromNotification(notification);
  }

  const resolvedReviewName = resolveGmbReviewResourceName(
    notification.account,
    notification.location,
    notification.review
  );

  const reviewData = await getReview(oauth2Client, resolvedReviewName);
  if (reviewData) {
    const normalized = normalizeRawReview(reviewData as RawReview);
    if (normalized) return normalized;
  }

  const locName =
    locationResourceName ??
    resolveGmbLocationResourceName(notification.account, notification.location);

  const reviews = await listReviews(oauth2Client, locName, 50, 1);
  const targetSuffix = extractReviewIdSuffix(resolvedReviewName);
  for (const candidate of reviews) {
    const raw = candidate as RawReview;
    if (!raw.name) continue;
    if (raw.name === resolvedReviewName || extractReviewIdSuffix(raw.name) === targetSuffix) {
      const normalized = normalizeRawReview(raw);
      if (normalized) return normalized;
    }
  }

  return buildReviewFromNotification(notification);
}
