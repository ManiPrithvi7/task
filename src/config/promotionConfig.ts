/** API key for web app → proofmqtt promotion cache invalidation webhook. */
export function resolvePromotionInvalidateApiKey(): string {
  return (
    process.env.PROMOTION_INVALIDATE_API_KEY?.trim() ||
    process.env.API_KEY?.trim() ||
    ''
  );
}
