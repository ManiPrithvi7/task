/**
 * Map OCI Object Storage SDK errors to HTTP-safe storage error codes.
 */

export type OciStorageErrorCode =
  | 'OBJECT_NOT_FOUND'
  | 'STORAGE_UNAVAILABLE'
  | 'STORAGE_FORBIDDEN'
  | 'STORAGE_BAD_REQUEST'
  | 'STORAGE_ERROR';

export class OciStorageError extends Error {
  readonly httpStatus: number;
  readonly code: OciStorageErrorCode;

  constructor(message: string, httpStatus: number, code: OciStorageErrorCode) {
    super(message);
    this.name = 'OciStorageError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

function statusFromMessage(msg: string): number | undefined {
  const m = msg.match(/\b(400|403|404|408|429|500|502|503|504)\b/);
  return m ? parseInt(m[1], 10) : undefined;
}

export function mapOciError(err: unknown): OciStorageError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  const status =
    (err as { statusCode?: number })?.statusCode ??
    (err as { status?: number })?.status ??
    statusFromMessage(message);

  if (status === 404 || lower.includes('not found') || lower.includes('notauthorizedornotfound')) {
    return new OciStorageError(message, 404, 'OBJECT_NOT_FOUND');
  }
  if (status === 403 || lower.includes('not authorized') || lower.includes('forbidden')) {
    return new OciStorageError(message, 403, 'STORAGE_FORBIDDEN');
  }
  if (status === 400 || lower.includes('invalid') || lower.includes('bad request')) {
    return new OciStorageError(message, 400, 'STORAGE_BAD_REQUEST');
  }
  if (
    status === 408 ||
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('econnreset') ||
    lower.includes('socket hang up')
  ) {
    return new OciStorageError(message, 503, 'STORAGE_UNAVAILABLE');
  }

  return new OciStorageError(message, 500, 'STORAGE_ERROR');
}

export function isRetryableOciError(err: unknown): boolean {
  if (err instanceof OciStorageError) {
    return err.code === 'STORAGE_UNAVAILABLE';
  }
  const mapped = mapOciError(err);
  return mapped.code === 'STORAGE_UNAVAILABLE';
}

export async function withOciRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !isRetryableOciError(err)) {
        throw err;
      }
      const delayMs = Math.min(2000, 250 * 2 ** (attempt - 1));
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
