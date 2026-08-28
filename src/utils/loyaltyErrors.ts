export class LoyaltyHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'LoyaltyHttpError';
  }
}

export function isDuplicateKeyError(err: unknown, field?: string): boolean {
  const e = err as { code?: number; keyPattern?: Record<string, unknown>; message?: string };
  if (e.code !== 11000) return false;
  if (!field) return true;
  if (e.keyPattern && field in e.keyPattern) return true;
  return typeof e.message === 'string' && e.message.includes(field);
}
