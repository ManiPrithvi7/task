/**
 * In-process metrics for Instagram polling / attention (Phase C/D).
 * Counters + rolling latency samples for attention → successful Graph API fetch (correlation_id path).
 */

const LATENCY_RING_MAX = 512;

const counters = {
  priorityCycles: 0,
  backgroundCycles: 0,
  fetchesEnqueued: 0,
  fetchesDeduped: 0,
  attentionImmediateSuccess: 0,
  attentionImmediateBackoffSkip: 0,
  circuitOpenSkips: 0,
  /** Circuit breaker entered open state (API / throttle). */
  circuitOpenEvents: 0,
  /** Global per-minute fetch budget rejected a publish. */
  fetchBudgetRejects: 0,
  /** Priority zset trimmed because it exceeded max members. */
  priorityZsetTrims: 0,
  /** Background scheduler advanced fair-rotation cursor. */
  backgroundFairRotateCycles: 0
};

export type IgPollCounterKey = keyof typeof counters;

export function igPollMetricsInc(key: IgPollCounterKey, n = 1): void {
  counters[key] += n;
}

/** Register start time when an attention immediate fetch is invoked (before serverless POST). */
const correlationStartMs = new Map<string, number>();
const MAX_CORRELATION_PENDING = 10_000;

export function registerAttentionCorrelationStart(correlationId: string): void {
  if (!correlationId) return;
  if (correlationStartMs.size >= MAX_CORRELATION_PENDING) {
    const k = correlationStartMs.keys().next().value;
    if (k !== undefined) correlationStartMs.delete(k);
  }
  correlationStartMs.set(correlationId, Date.now());
}

/** Drop pending E2E timer without recording (fetch failed or early exit). */
export function abandonAttentionCorrelation(correlationId: string | undefined): void {
  if (!correlationId) return;
  correlationStartMs.delete(correlationId);
}

/**
 * Record attention → first successful API response latency when `correlation_id` matches a prior register.
 * Returns latency ms or undefined if unmatched.
 */
export function observeAttentionFetchLatencyMs(correlationId: string | undefined): number | undefined {
  if (!correlationId) return undefined;
  const t0 = correlationStartMs.get(correlationId);
  if (t0 === undefined) return undefined;
  correlationStartMs.delete(correlationId);
  const ms = Date.now() - t0;
  recordLatencySample(ms);
  return ms;
}

const latencyRing: number[] = [];

function recordLatencySample(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  latencyRing.push(ms);
  if (latencyRing.length > LATENCY_RING_MAX) {
    latencyRing.splice(0, latencyRing.length - LATENCY_RING_MAX);
  }
}

function percentile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

export interface AttentionE2eLatencySnapshot {
  count: number;
  sumMs: number;
  minMs?: number;
  maxMs?: number;
  p50ApproxMs?: number;
  p95ApproxMs?: number;
}

function buildLatencySnapshot(): AttentionE2eLatencySnapshot {
  if (latencyRing.length === 0) {
    return { count: 0, sumMs: 0 };
  }
  const sorted = [...latencyRing].sort((a, b) => a - b);
  const sumMs = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    sumMs,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    p50ApproxMs: percentile(sorted, 0.5),
    p95ApproxMs: percentile(sorted, 0.95)
  };
}

export function getInstagramPollingMetricsSnapshot(): Record<string, unknown> {
  return {
    ...counters,
    attentionE2eLatencyMs: buildLatencySnapshot()
  };
}
