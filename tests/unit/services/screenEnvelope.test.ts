import {
  gmbReviewMetrics,
  instagramFollowerMetrics
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
