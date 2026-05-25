import type { GmbReviewNotification as GmbReviewNotificationType } from '../../lib/socials/integrations';

export type GmbReviewNotification = GmbReviewNotificationType;

export const SUPPORTED_GMB_EVENT_TYPES = new Set(['NEW_REVIEW', 'UPDATED_REVIEW']);

export {
  isGmbTestNotification,
  resolveGmbAccountResourceName,
  resolveGmbLocationResourceName,
  getGmbAccountLookupValues
} from '../../lib/socials/integrations';

export const buildGmbDedupeKey = (
  account: string,
  location: string,
  reviewId: string
): string => `gmb:${account}:${location}:${reviewId}`;
