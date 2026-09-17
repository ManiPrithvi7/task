import {
  buildGmbScreenPayload,
  buildInstagramScreenPayload,
  buildLoyaltyIdleEnvelope,
  buildLoyaltySpinStartEnvelope,
  gmbReviewMetrics,
  getInstagramMegaCrossedMilestones,
  instagramFollowerMetrics,
  parseLoyaltyScreenEnvelope,
  resolveCelebrationState
} from '../../../src/services/screenEnvelope';

describe('instagramFollowerMetrics (every 5)', () => {
  it('points nextGoal at 5 for counts in 0–4', () => {
    expect(instagramFollowerMetrics(0).nextGoal).toBe(5);
    expect(instagramFollowerMetrics(2).nextGoal).toBe(5);
    expect(instagramFollowerMetrics(4).remainingGoal).toBe(1);
  });

  it('on exact milestone, nextGoal advances to the next slab', () => {
    expect(instagramFollowerMetrics(5)).toEqual({
      nextGoal: 10,
      remainingGoal: 5,
      progress: 0
    });
    expect(instagramFollowerMetrics(10).nextGoal).toBe(15);
  });
});

describe('gmbReviewMetrics (every 5)', () => {
  it('points nextGoal at next multiple of 5', () => {
    expect(gmbReviewMetrics(3).nextGoal).toBe(5);
    expect(gmbReviewMetrics(5).nextGoal).toBe(10);
    expect(gmbReviewMetrics(10)).toMatchObject({
      nextGoal: 15,
      remainingGoal: 5,
      progress: 0
    });
  });
});

describe('resolveCelebrationState', () => {
  it('IG mini every 5, mega every 10 (mega wins)', () => {
    expect(resolveCelebrationState('instagram', 5)).toEqual({
      celebration: 'true',
      celebrationType: 'mini'
    });
    expect(resolveCelebrationState('instagram', 15)).toEqual({
      celebration: 'true',
      celebrationType: 'mini'
    });
    expect(resolveCelebrationState('instagram', 10)).toEqual({
      celebration: 'true',
      celebrationType: 'mega'
    });
    expect(resolveCelebrationState('instagram', 20)).toEqual({
      celebration: 'true',
      celebrationType: 'mega'
    });
    expect(resolveCelebrationState('instagram', 9847)).toEqual({ celebration: 'false' });
  });

  it('GMB mini every 5, mega every 10 (mega wins)', () => {
    expect(resolveCelebrationState('gmb', 15)).toEqual({
      celebration: 'true',
      celebrationType: 'mini'
    });
    expect(resolveCelebrationState('gmb', 25)).toEqual({
      celebration: 'true',
      celebrationType: 'mini'
    });
    expect(resolveCelebrationState('gmb', 10)).toEqual({
      celebration: 'true',
      celebrationType: 'mega'
    });
    expect(resolveCelebrationState('gmb', 50)).toEqual({
      celebration: 'true',
      celebrationType: 'mega'
    });
    expect(resolveCelebrationState('gmb', 42)).toEqual({ celebration: 'false' });
  });
});

describe('buildInstagramScreenPayload', () => {
  it('normal state uses achievement and omits celebration_type', () => {
    const { payload, envelopeOpts } = buildInstagramScreenPayload({ followers: 9847 });
    expect(envelopeOpts).toEqual({ muted: 'true', celebration: 'false' });
    expect(payload).toEqual({
      followers: 9847,
      achievement: 9850,
      remainingGoal: 3,
      progress: 40,
      qrText: 'https://www.instagram.com/'
    });
    expect(payload).not.toHaveProperty('celebration_type');
  });

  it('mini celebration at +5 boundary', () => {
    const { payload, envelopeOpts } = buildInstagramScreenPayload({ followers: 15 });
    expect(envelopeOpts.celebration).toBe('true');
    expect(payload.celebration_type).toBe('mini');
    expect(payload).toMatchObject({
      followers: 15,
      achievement: 15,
      remainingGoal: 0,
      progress: 100
    });
  });

  it('mega celebration at every 10', () => {
    const { payload, envelopeOpts } = buildInstagramScreenPayload({ followers: 10 });
    expect(envelopeOpts.celebration).toBe('true');
    expect(payload.celebration_type).toBe('mega');
    expect(payload).toMatchObject({
      followers: 10,
      achievement: 10,
      remainingGoal: 0,
      progress: 100
    });
  });
});

describe('buildGmbScreenPayload', () => {
  it('normal state omits celebration_type', () => {
    const { payload, envelopeOpts } = buildGmbScreenPayload({ verifiedReview: 228 });
    expect(envelopeOpts).toEqual({ muted: 'false', celebration: 'false' });
    expect(payload).toMatchObject({
      verifiedReview: 228,
      nextGoal: 230,
      remainingGoal: 2
    });
    expect(payload).not.toHaveProperty('celebration_type');
  });

  it('mini celebration at +5 boundary', () => {
    const { payload, envelopeOpts } = buildGmbScreenPayload({ verifiedReview: 15 });
    expect(envelopeOpts.celebration).toBe('true');
    expect(payload.celebration_type).toBe('mini');
    expect(payload).toMatchObject({
      verifiedReview: 15,
      nextGoal: 15,
      remainingGoal: 0,
      progress: 100
    });
  });

  it('mega celebration at every 10', () => {
    const { payload, envelopeOpts } = buildGmbScreenPayload({ verifiedReview: 20 });
    expect(envelopeOpts.celebration).toBe('true');
    expect(payload.celebration_type).toBe('mega');
    expect(payload).toMatchObject({
      verifiedReview: 20,
      nextGoal: 20,
      remainingGoal: 0,
      progress: 100
    });
  });
});

describe('getInstagramMegaCrossedMilestones', () => {
  it('returns every 10 crossed between old and new', () => {
    expect(getInstagramMegaCrossedMilestones(95, 125)).toEqual([100, 110, 120]);
    expect(getInstagramMegaCrossedMilestones(100, 100)).toEqual([]);
  });
});

describe('parseLoyaltyScreenEnvelope', () => {
  const valid = {
    version: '1.2',
    screen: 'loyalty',
    celebration: 'false',
    muted: 'false',
    timestamp: '2026-08-29T10:00:00.000Z',
    payload: { type: 'loyalty-idle', businessName: 'Atlus Coffee Co.' }
  };

  it('accepts a valid loyalty envelope', () => {
    const parsed = parseLoyaltyScreenEnvelope(valid);
    expect(parsed?.payload.type).toBe('loyalty-idle');
    expect(parsed?.envelope.version).toBe('1.2');
  });

  it('rejects bad version, screen, timestamp, or payload', () => {
    expect(parseLoyaltyScreenEnvelope(null)).toBeNull();
    expect(parseLoyaltyScreenEnvelope({ ...valid, version: '1.1' })).toBeNull();
    expect(parseLoyaltyScreenEnvelope({ ...valid, screen: 'instagram' })).toBeNull();
    expect(parseLoyaltyScreenEnvelope({ ...valid, timestamp: 'not-a-date' })).toBeNull();
    expect(parseLoyaltyScreenEnvelope({ ...valid, payload: 'x' })).toBeNull();
  });
});

describe('buildLoyaltyIdleEnvelope', () => {
  it('wraps loyalty-idle with celebration and muted false', () => {
    const ts = new Date('2026-05-15T10:35:00.000Z');
    expect(buildLoyaltyIdleEnvelope('Atlus Coffee Co.', ts)).toEqual({
      version: '1.2',
      screen: 'loyalty',
      celebration: 'false',
      muted: 'false',
      timestamp: '2026-05-15T10:35:00.000Z',
      payload: { type: 'loyalty-idle', businessName: 'Atlus Coffee Co.' }
    });
  });
});

describe('buildLoyaltySpinStartEnvelope', () => {
  it('wraps spin-start with muted true and matching timestamp', () => {
    const inner = {
      type: 'spin-start' as const,
      spinId: 'spin_1',
      ttlMs: 10_000,
      result: { digits: ['HEARTS'], value: 100, reward: 'Free Coffee' },
      issuedAt: '2026-08-29T10:00:00.000Z',
      expiresAt: '2026-08-29T10:00:30.000Z'
    };
    const envelope = buildLoyaltySpinStartEnvelope(inner);
    expect(envelope.screen).toBe('loyalty');
    expect(envelope.muted).toBe('true');
    expect(envelope.timestamp).toBe(inner.issuedAt);
    expect(envelope.payload).toEqual(inner);
  });
});
