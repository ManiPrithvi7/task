const MIN_DAYS = 1 / 24; // 1 hour floor — avoid Infinity / NaN

/**
 * Followers or reviews per day between two counts.
 * No previous timestamp → 0. Elapsed time floored at 1 hour.
 */
export function computeVelocityPerDay(
  oldCount: number,
  newCount: number,
  lastTsMs: number | null | undefined,
  nowMs: number = Date.now()
): number {
  if (lastTsMs == null || !Number.isFinite(lastTsMs)) return 0;
  const elapsedMs = nowMs - lastTsMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  const days = Math.max(elapsedMs / 86_400_000, MIN_DAYS);
  return (newCount - oldCount) / days;
}
