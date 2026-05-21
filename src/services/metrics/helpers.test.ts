import { getDateBucket, priceToCents } from './helpers';

describe('metrics helpers', () => {
  it('converts price to cents', () => {
    expect(priceToCents('10.50')).toBe(1050);
    expect(priceToCents('0')).toBe(0);
  });

  it('builds date bucket with positive ttl', () => {
    const { dateKey, ttlSeconds } = getDateBucket('2026-05-21T12:00:00.000Z', 'UTC');
    expect(dateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ttlSeconds).toBeGreaterThan(0);
  });
});
