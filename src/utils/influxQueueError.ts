export function influxWriteErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Permanent client/parse errors — retrying the same line will never succeed. */
export function isPermanentInfluxWriteError(err: unknown): boolean {
  const msg = influxWriteErrorMessage(err);
  if (/unable to parse|value out of range|invalid argument|field type conflict/i.test(msg)) {
    return true;
  }
  const statusCode = (err as { statusCode?: number })?.statusCode;
  if (statusCode === 400 || statusCode === 422) return true;
  return false;
}
