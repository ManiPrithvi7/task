/** statsmqtt integration primitives (@proof-socials/socials npm — not Statsnapp app code). */
import { gmb, webhooks, ig, isAccessTokenExpired, normalizeRefreshToken } from '@proof-socials/socials';

export { gmb, webhooks, ig, isAccessTokenExpired, normalizeRefreshToken };

export const {
  verifyShopifyWebhook,
  verifySquareWebhook,
  isSquarePaymentEvent,
  isSquareInvoiceEvent,
  isSquareAppWebhookEvent,
  parseSquareWebhookEnvelope,
  getIdString,
  buildReviewFromNotification,
  isGmbTestNotification,
  resolveGmbAccountResourceName,
  resolveGmbLocationResourceName,
  resolveGmbReviewPayload,
  resolveGmbReviewResourceName
} = webhooks;

export type GmbReviewNotification = webhooks.GmbReviewNotification;
export type GmbReviewPayload = webhooks.GmbReviewPayload;
export type ResolveGmbReviewPayloadOptions = webhooks.ResolveGmbReviewPayloadOptions;

export const getGmbAccountLookupValues = (account: string): string[] => {
  const full = resolveGmbAccountResourceName(account);
  const bare = full.startsWith('accounts/') ? full.slice('accounts/'.length) : full;
  return bare === full ? [full] : [full, bare];
};

export const mapReviewPayloadToStorage = (review: GmbReviewPayload) => {
  const createTime = review.createTime ? new Date(review.createTime) : new Date();
  return {
    reviewId: review.name,
    starRating: gmb.mapGmbStarRating(review.starRating),
    comment: review.comment,
    reviewerName: review.reviewer.displayName,
    createTime,
    updateTime: new Date(review.updateTime ?? review.createTime)
  };
};
