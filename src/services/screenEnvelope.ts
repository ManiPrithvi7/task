/**
 * PROOF Display screen MQTT envelope — v6 adds always-present string `celebration` ("true"|"false").
 * Envelope `version` remains "1.2".
 */

export type ScreenId = 'instagram' | 'gmb' | 'pos' | 'promotion';

export type ScreenEnvelope<TPayload> = {
  version: '1.2';
  screen: ScreenId;
  muted: 'true' | 'false';
  celebration: 'true' | 'false';
  timestamp: string;
  payload: TPayload;
};

export type BuildScreenEnvelopeOpts = {
  muted?: 'true' | 'false';
  timestamp?: Date;
  celebration?: 'true' | 'false';
};

export function buildScreenEnvelope<TPayload>(
  screen: ScreenId,
  payload: TPayload,
  opts?: BuildScreenEnvelopeOpts
): ScreenEnvelope<TPayload> {
  return {
    version: '1.2',
    screen,
    muted: opts?.muted ?? 'true',
    celebration: opts?.celebration ?? 'false',
    timestamp: (opts?.timestamp ?? new Date()).toISOString(),
    payload
  };
}

/** Instagram v6 milestone math: +25 follower boundaries; firmware reads pre-computed values. */
export function instagramFollowerMetrics(followers: number): {
  nextGoal: number;
  remainingGoal: number;
  progress: number;
} {
  const f = Math.max(0, Math.floor(followers));
  const nextGoal = f === 0 ? 25 : Math.ceil(f / 25) * 25;
  const prevMilestone = Math.floor(f / 25) * 25;
  const span = Math.max(1, nextGoal - prevMilestone);
  const progress = Math.max(0, Math.min(100, Math.round(((f - prevMilestone) / span) * 100)));
  const remainingGoal = Math.max(0, nextGoal - f);
  return { nextGoal, remainingGoal, progress };
}

/** GMB: nextGoal is next multiple of 5 above verifiedReview; progress within current 5-review slab. */
export function gmbReviewMetrics(verifiedReview: number): {
  nextGoal: number;
  remainingGoal: number;
  progress: number;
} {
  const r = Math.max(0, Math.floor(verifiedReview));
  const nextGoal = Math.floor(r / 5) * 5 + 5;
  const remainingGoal = Math.max(0, nextGoal - r);
  const slabStart = Math.floor(r / 5) * 5;
  const span = Math.max(1, nextGoal - slabStart);
  const progress = Math.max(0, Math.min(100, Math.round(((r - slabStart) / span) * 100)));
  return { nextGoal, remainingGoal, progress };
}
