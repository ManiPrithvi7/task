export interface GmbReviewNotification {
  account?: string;
  location?: string;
  eventType?: string;
  review?: string;
  comment?: string;
  starRating?: number | string;
  reviewer?: { displayName?: string };
  createTime?: string;
  updateTime?: string;
}

export const SUPPORTED_GMB_EVENT_TYPES = new Set(['NEW_REVIEW', 'UPDATED_REVIEW']);

export const isGmbTestNotification = (notification: GmbReviewNotification): boolean => {
  const review = notification.review ?? '';
  return (
    review.includes('TEST_REVIEW_ID') ||
    review.includes('/reviews/TEST_') ||
    notification.eventType === 'TEST'
  );
};

export const resolveGmbAccountResourceName = (account: string): string =>
  account.startsWith('accounts/') ? account : `accounts/${account}`;

export const resolveGmbLocationResourceName = (account: string, location: string): string => {
  if (location.startsWith('accounts/')) return location;
  const accountName = resolveGmbAccountResourceName(account);
  if (location.startsWith('locations/')) {
    return `${accountName}/${location}`;
  }
  return `${accountName}/locations/${location}`;
};

export const getGmbAccountLookupValues = (account: string): string[] => {
  const resourceName = resolveGmbAccountResourceName(account);
  const numericId = resourceName.replace(/^accounts\//, '');
  return [...new Set([account, resourceName, numericId])];
};

export const resolveGmbReviewResourceName = (
  account: string,
  location: string,
  review: string
): string => {
  if (review.startsWith('accounts/')) return review;
  const locationName = resolveGmbLocationResourceName(account, location);
  if (review.startsWith('locations/')) {
    return `${resolveGmbAccountResourceName(account)}/${review}`;
  }
  if (review.includes('/reviews/')) {
    return `${resolveGmbAccountResourceName(account)}/${review.replace(/^\/+/, '')}`;
  }
  if (review.startsWith('reviews/')) {
    return `${locationName}/${review}`;
  }
  return `${locationName}/reviews/${review}`;
};

export const buildReviewFromNotification = (
  notification: GmbReviewNotification
): {
  name: string;
  starRating: number | string;
  comment: string | null;
  reviewer: { displayName: string };
  createTime: string;
  updateTime: string;
} => {
  const account = notification.account ?? '';
  const location = notification.location ?? '';
  const reviewName = notification.review ?? 'reviews/TEST_REVIEW_ID';
  const now = new Date().toISOString();

  return {
    name: resolveGmbReviewResourceName(account, location, reviewName),
    starRating: notification.starRating ?? 'FIVE',
    comment:
      typeof notification.comment === 'string'
        ? notification.comment
        : 'Test review from Google Pub/Sub console',
    reviewer: {
      displayName: notification.reviewer?.displayName ?? 'Google Pub/Sub Test'
    },
    createTime: notification.createTime ?? now,
    updateTime: notification.updateTime ?? now
  };
};

export const buildGmbDedupeKey = (
  account: string,
  location: string,
  review: string
): string => `gmb:${account}:${location}:${review}`;
