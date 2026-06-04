/** API key for web app → proofmqtt connections validate webhook. */
export function resolveConnectionsValidateApiKey(): string {
  return (
    process.env.CONNECTIONS_VALIDATE_API_KEY?.trim() ||
    process.env.PROMOTION_INVALIDATE_API_KEY?.trim() ||
    process.env.API_KEY?.trim() ||
    ''
  );
}

export function getClaimBaseUrl(): string {
  const base = process.env.CLAIM_BASE_URL?.trim() || 'https://statsnapp.vercel.app';
  return base.replace(/\/$/, '');
}
