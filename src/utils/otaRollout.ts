/**
 * OTA staged rollout helpers — hash bucket, reason codes, percentage steps.
 */

import * as crypto from 'crypto';

export const OTA_ROLLOUT_STEPS = [1, 10, 50, 100] as const;
export type OtaRolloutStep = (typeof OTA_ROLLOUT_STEPS)[number];

export function deviceHashBucket(deviceId: string): number {
  return crypto.createHash('sha256').update(deviceId).digest()[0] % 100;
}

/** Normalize firmware reason codes (hyphen or underscore) to underscore form. */
export function normalizeOtaReasonCode(reason?: string): string | undefined {
  if (!reason?.trim()) return undefined;
  return reason
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
    .replace(/\s+/g, '_');
}

const TRANSIENT_CODES = new Set(['download_failed', 'download_timeout']);
const PERMANENT_CODES = new Set([
  'sha256_mismatch',
  'signature_invalid',
  'flash_error',
  'health_check_failed',
  'rollback'
]);

export type OtaReasonKind = 'transient' | 'permanent' | 'track_mismatch' | 'unknown';

export function classifyOtaReason(reason?: string): OtaReasonKind {
  const code = normalizeOtaReasonCode(reason);
  if (!code) return 'unknown';
  if (code === 'track_mismatch') return 'track_mismatch';
  if (TRANSIENT_CODES.has(code)) return 'transient';
  if (PERMANENT_CODES.has(code)) return 'permanent';
  // Legacy aliases
  if (code === 'download_timeout' || code === 'downloadtimeout') return 'transient';
  return 'unknown';
}

export function shouldIncrementFailed(kind: OtaReasonKind, code?: string): boolean {
  if (kind === 'track_mismatch') return false;
  if (kind === 'transient' || kind === 'permanent' || kind === 'unknown') {
    if (normalizeOtaReasonCode(code) === 'rollback') return false;
    return true;
  }
  return false;
}

export function shouldIncrementRolledBack(kind: OtaReasonKind, code?: string): boolean {
  const normalized = normalizeOtaReasonCode(code);
  return (
    kind === 'permanent' &&
    (normalized === 'health_check_failed' || normalized === 'rollback')
  );
}

export function nextRolloutPercentage(current: number): OtaRolloutStep | null {
  const idx = OTA_ROLLOUT_STEPS.findIndex((s) => s === current);
  if (idx >= 0 && idx < OTA_ROLLOUT_STEPS.length - 1) {
    return OTA_ROLLOUT_STEPS[idx + 1];
  }
  // Allow starting from non-canonical values by snapping to next greater step
  for (const step of OTA_ROLLOUT_STEPS) {
    if (step > current) return step;
  }
  return null;
}

export function isValidRolloutStep(pct: number): pct is OtaRolloutStep {
  return (OTA_ROLLOUT_STEPS as readonly number[]).includes(pct);
}

export function stageFailureRate(attempted: number, failed: number, rolledBack: number): number {
  if (attempted <= 0) return 0;
  return (failed + rolledBack) / attempted;
}

export function shouldAbortStage(
  attempted: number,
  failed: number,
  rolledBack: number,
  minSample: number,
  maxFailureRate: number
): boolean {
  if (attempted < minSample) return false;
  return stageFailureRate(attempted, failed, rolledBack) >= maxFailureRate;
}

export function canAdvanceStage(input: {
  aborted: boolean;
  currentPercentage: number;
  stageStartedAt?: Date | null;
  attempted: number;
  failed: number;
  rolledBack: number;
  minHours: number;
  minSample: number;
  maxFailureRate: number;
  now?: Date;
}): boolean {
  if (input.aborted) return false;
  if (input.currentPercentage >= 100) return false;
  if (!input.stageStartedAt) return false;
  const now = input.now ?? new Date();
  const hours =
    (now.getTime() - new Date(input.stageStartedAt).getTime()) / 3_600_000;
  if (hours < input.minHours) return false;
  if (input.attempted < input.minSample) return false;
  return (
    stageFailureRate(input.attempted, input.failed, input.rolledBack) < input.maxFailureRate
  );
}

/** Run async work over items with a fixed concurrency limit. */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, concurrency);
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
