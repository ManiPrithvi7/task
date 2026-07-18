import {
  buildGmbScreenPayload,
  buildInstagramScreenPayload,
  gmbReviewMetrics,
  getInstagramMegaCrossedMilestones,
  instagramFollowerMetrics,
  resolveCelebrationState
} from '../../../src/services/screenEnvelope';

describe('instagramFollowerMetrics (every 25)', () => {
  it('points nextGoal at 25 for counts in 0–24', () => {
    expect(instagramFollowerMetrics(0).nextGoal).toBe(25);
    expect(instagramFollowerMetrics(12).nextGoal).toBe(25);
    expect(instagramFollowerMetrics(24).remainingGoal).toBe(1);
  });

  it('on exact milestone, nextGoal advances to the next slab', () => {
    expect(instagramFollowerMetrics(25)).toEqual({
      nextGoal: 50,
      remainingGoal: 25,
      progress: 0
    });
    expect(instagramFollowerMetrics(50).nextGoal).toBe(75);
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
  it('IG mini every 25, mega every 100 (mega wins)', () => {
    expect(resolveCelebrationState('instagram', 50)).toEqual({
      celebration: 'true',
      celebrationType: 'mini'
    });
    expect(resolveCelebrationState('instagram', 75)).toEqual({
      celebration: 'true',
      celebrationType: 'mini'
    });
    expect(resolveCelebrationState('instagram', 100)).toEqual({
      celebration: 'true',
      celebrationType: 'mega'
    });
    expect(resolveCelebrationState('instagram', 9847)).toEqual({ celebration: 'false' });
  });

  it('GMB mini every 5, mega every 25 (mega wins)', () => {
    expect(resolveCelebrationState('gmb', 15)).toEqual({
      celebration: 'true',
      celebrationType: 'mini'
    });
    expect(resolveCelebrationState('gmb', 25)).toEqual({
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
      progress: 88,
      qrText: 'https://www.instagram.com/'
    });
    expect(payload).not.toHaveProperty('celebration_type');
  });

  it('mini celebration at +25 boundary', () => {
    const { payload, envelopeOpts } = buildInstagramScreenPayload({ followers: 50 });
    expect(envelopeOpts.celebration).toBe('true');
    expect(payload.celebration_type).toBe('mini');
    expect(payload).toMatchObject({
      followers: 50,
      achievement: 50,
      remainingGoal: 0,
      progress: 100
    });
  });

  it('mega celebration at every 100', () => {
    const { payload, envelopeOpts } = buildInstagramScreenPayload({ followers: 100 });
    expect(envelopeOpts.celebration).toBe('true');
    expect(payload.celebration_type).toBe('mega');
    expect(payload).toMatchObject({
      followers: 100,
      achievement: 100,
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

  it('mega celebration at every 25', () => {
    const { payload, envelopeOpts } = buildGmbScreenPayload({ verifiedReview: 25 });
    expect(envelopeOpts.celebration).toBe('true');
    expect(payload.celebration_type).toBe('mega');
    expect(payload).toMatchObject({
      verifiedReview: 25,
      nextGoal: 25,
      remainingGoal: 0,
      progress: 100
    });
  });
});

describe('getInstagramMegaCrossedMilestones', () => {
  it('returns every 100 crossed between old and new', () => {
    expect(getInstagramMegaCrossedMilestones(95, 205)).toEqual([100, 200]);
    expect(getInstagramMegaCrossedMilestones(100, 100)).toEqual([]);
  });
});
