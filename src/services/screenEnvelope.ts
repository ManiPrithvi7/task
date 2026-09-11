/**
 * PROOF Display screen MQTT envelope — v1.2 with string `celebration` ("true"|"false").
 */

export type ScreenId = 'instagram' | 'gmb' | 'pos' | 'promotion' | 'loyalty';

export type LoyaltyIdlePayload = {
  type: 'loyalty-idle';
  businessName: string;
};

export type LoyaltySpinStartPayload = {
  type: 'spin-start';
  spinId: string;
  ttlMs: number;
  result: {
    digits: string[];
    value: number;
    reward: string;
  };
  issuedAt: string;
  expiresAt: string;
};

export type LoyaltySpinAckPayload = {
  type: 'spin-ack';
  spinId: string;
  startedAt: string;
  ttlMs: number;
};

export type ParsedLoyaltyScreenEnvelope = {
  envelope: ScreenEnvelope<Record<string, unknown>>;
  payload: Record<string, unknown>;
};

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

export const IG_MINI_INTERVAL = 5;
export const IG_MEGA_INTERVAL = 25;
export const GMB_MINI_INTERVAL = 5;
export const GMB_MEGA_INTERVAL = 25;

export type CelebrationType = 'mini' | 'mega';

export type CelebrationState =
  | { celebration: 'false' }
  | { celebration: 'true'; celebrationType: CelebrationType };

export type GmbReviewItem = { id: number; googleReview: string; rating: string };

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

function isValidIso8601(value: string): boolean {
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed);
}

/** Stage 1 envelope validation for loyalty-scope MQTT messages. */
export function parseLoyaltyScreenEnvelope(raw: unknown): ParsedLoyaltyScreenEnvelope | null {
  if (!raw || typeof raw !== 'object') return null;
  const msg = raw as Record<string, unknown>;
  if (msg.version !== '1.2') return null;
  if (msg.screen !== 'loyalty') return null;
  if (typeof msg.timestamp !== 'string' || !isValidIso8601(msg.timestamp)) return null;
  if (!msg.payload || typeof msg.payload !== 'object') return null;
  if (msg.celebration !== 'true' && msg.celebration !== 'false') return null;
  if (msg.muted !== 'true' && msg.muted !== 'false') return null;

  return {
    envelope: msg as ScreenEnvelope<Record<string, unknown>>,
    payload: msg.payload as Record<string, unknown>
  };
}

export function buildLoyaltyIdleEnvelope(
  businessName: string,
  timestamp?: Date
): ScreenEnvelope<LoyaltyIdlePayload> {
  return buildScreenEnvelope(
    'loyalty',
    { type: 'loyalty-idle', businessName },
    { celebration: 'false', muted: 'false', timestamp }
  );
}

export function buildLoyaltySpinStartEnvelope(
  inner: LoyaltySpinStartPayload,
  opts?: Pick<BuildScreenEnvelopeOpts, 'muted' | 'celebration'>
): ScreenEnvelope<LoyaltySpinStartPayload> {
  return buildScreenEnvelope('loyalty', inner, {
    timestamp: new Date(inner.issuedAt),
    celebration: opts?.celebration ?? 'false',
    muted: opts?.muted ?? 'true'
  });
}

/** Mega checked first — mega wins when both mini and mega match. */
export function resolveCelebrationState(
  platform: 'instagram' | 'gmb',
  count: number
): CelebrationState {
  const c = Math.max(0, Math.floor(count));
  if (c <= 0) return { celebration: 'false' };

  if (platform === 'instagram') {
    if (c % IG_MEGA_INTERVAL === 0) return { celebration: 'true', celebrationType: 'mega' };
    if (c % IG_MINI_INTERVAL === 0) return { celebration: 'true', celebrationType: 'mini' };
  } else {
    if (c % GMB_MEGA_INTERVAL === 0) return { celebration: 'true', celebrationType: 'mega' };
    if (c % GMB_MINI_INTERVAL === 0) return { celebration: 'true', celebrationType: 'mini' };
  }
  return { celebration: 'false' };
}

/** Instagram slab milestone math for normal (non-celebration) states. */
export function instagramFollowerMetrics(followers: number): {
  nextGoal: number;
  remainingGoal: number;
  progress: number;
} {
  const f = Math.max(0, Math.floor(followers));
  const nextGoal = Math.floor(f / IG_MINI_INTERVAL) * IG_MINI_INTERVAL + IG_MINI_INTERVAL;
  const prevMilestone = Math.floor(f / IG_MINI_INTERVAL) * IG_MINI_INTERVAL;
  const span = Math.max(1, nextGoal - prevMilestone);
  const progress = Math.max(0, Math.min(100, Math.round(((f - prevMilestone) / span) * 100)));
  const remainingGoal = Math.max(0, nextGoal - f);
  return { nextGoal, remainingGoal, progress };
}

/** GMB slab milestone math for normal (non-celebration) states. */
export function gmbReviewMetrics(verifiedReview: number): {
  nextGoal: number;
  remainingGoal: number;
  progress: number;
} {
  const r = Math.max(0, Math.floor(verifiedReview));
  const nextGoal = Math.floor(r / GMB_MINI_INTERVAL) * GMB_MINI_INTERVAL + GMB_MINI_INTERVAL;
  const remainingGoal = Math.max(0, nextGoal - r);
  const slabStart = Math.floor(r / GMB_MINI_INTERVAL) * GMB_MINI_INTERVAL;
  const span = Math.max(1, nextGoal - slabStart);
  const progress = Math.max(0, Math.min(100, Math.round(((r - slabStart) / span) * 100)));
  return { nextGoal, remainingGoal, progress };
}

export type GmbScreenPayloadInput = {
  verifiedReview: number;
  rating?: number;
  qrText?: string;
  reviews?: GmbReviewItem[];
};

export function buildGmbScreenPayload(input: GmbScreenPayloadInput): {
  payload: Record<string, unknown>;
  envelopeOpts: BuildScreenEnvelopeOpts;
} {
  const verifiedReview = Math.max(0, Math.floor(input.verifiedReview));
  const state = resolveCelebrationState('gmb', verifiedReview);
  const rating = input.rating ?? 4;
  const reviews = input.reviews ?? [];

  let nextGoal: number;
  let remainingGoal: number;
  let progress: number;

  if (state.celebration === 'true') {
    nextGoal = verifiedReview;
    remainingGoal = 0;
    progress = 100;
  } else {
    const m = gmbReviewMetrics(verifiedReview);
    nextGoal = m.nextGoal;
    remainingGoal = m.remainingGoal;
    progress = m.progress;
  }

  const payload: Record<string, unknown> = {
    qrText: input.qrText ?? 'https://g.page/r/review',
    verifiedReview,
    rating,
    nextGoal,
    remainingGoal,
    progress,
    reviews
  };

  if (state.celebration === 'true') {
    payload.celebration_type = state.celebrationType;
  }

  return {
    payload,
    envelopeOpts: { muted: 'false', celebration: state.celebration }
  };
}

export type InstagramScreenPayloadInput = {
  followers: number;
  qrText?: string;
};

export function buildInstagramScreenPayload(input: InstagramScreenPayloadInput): {
  payload: Record<string, unknown>;
  envelopeOpts: BuildScreenEnvelopeOpts;
} {
  const followers = Math.max(0, Math.floor(input.followers));
  const state = resolveCelebrationState('instagram', followers);

  let achievement: number;
  let remainingGoal: number;
  let progress: number;

  if (state.celebration === 'true') {
    achievement = followers;
    remainingGoal = 0;
    progress = 100;
  } else {
    const m = instagramFollowerMetrics(followers);
    achievement = m.nextGoal;
    remainingGoal = m.remainingGoal;
    progress = m.progress;
  }

  const payload: Record<string, unknown> = {
    followers,
    achievement,
    remainingGoal,
    progress,
    qrText: input.qrText ?? 'https://www.instagram.com/'
  };

  if (state.celebration === 'true') {
    payload.celebration_type = state.celebrationType;
  }

  return {
    payload,
    envelopeOpts: { muted: 'true', celebration: state.celebration }
  };
}

/** IG mega milestones crossed between old and new follower counts (every 100). */
export function getInstagramMegaCrossedMilestones(oldF: number, newF: number): number[] {
  if (oldF >= newF) return [];
  const milestones: number[] = [];
  const start = Math.max(
    IG_MEGA_INTERVAL,
    Math.ceil((oldF + 1) / IG_MEGA_INTERVAL) * IG_MEGA_INTERVAL
  );
  for (let m = start; m <= newF; m += IG_MEGA_INTERVAL) {
    milestones.push(m);
  }
  return milestones;
}
