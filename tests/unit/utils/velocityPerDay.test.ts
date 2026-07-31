import { computeVelocityPerDay } from '@/utils/velocityPerDay';

describe('computeVelocityPerDay', () => {
  it('returns 0 when no previous timestamp', () => {
    expect(computeVelocityPerDay(100, 110, null)).toBe(0);
    expect(computeVelocityPerDay(100, 110, undefined)).toBe(0);
  });

  it('floors elapsed time at 1 hour (1/24 day)', () => {
    const now = 1_000_000;
    const oneMinuteAgo = now - 60_000;
    // delta 24 over 1/24 day → 576/day
    expect(computeVelocityPerDay(100, 124, oneMinuteAgo, now)).toBeCloseTo(24 / (1 / 24), 5);
  });

  it('computes over multi-day window', () => {
    const now = Date.parse('2026-07-31T00:00:00.000Z');
    const twoDaysAgo = now - 2 * 86_400_000;
    expect(computeVelocityPerDay(100, 120, twoDaysAgo, now)).toBeCloseTo(10, 5);
  });

  it('allows negative delta', () => {
    const now = 1_000_000;
    const dayAgo = now - 86_400_000;
    expect(computeVelocityPerDay(100, 90, dayAgo, now)).toBeCloseTo(-10, 5);
  });
});
