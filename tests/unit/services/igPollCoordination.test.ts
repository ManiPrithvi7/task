import { describe, expect, it } from 'bun:test';
import {
  LocalBudgetTracker,
  LocalDeviceBackoff,
  LocalFetchDedupe,
  consumeFetchBudget
} from '../../../src/services/igPollCoordination';

describe('LocalDeviceBackoff', () => {
  it('allows up to threshold attempts in window', async () => {
    const b = new LocalDeviceBackoff(2, 60_000);
    expect(await b.shouldAllow('d1')).toBe(true);
    expect(await b.shouldAllow('d1')).toBe(true);
    expect(await b.shouldAllow('d1')).toBe(false);
  });
});

describe('LocalBudgetTracker', () => {
  it('rejects when over limit', async () => {
    const b = new LocalBudgetTracker();
    expect(await consumeFetchBudget(b, 2)).toBe(true);
    expect(await consumeFetchBudget(b, 2)).toBe(true);
    expect(await consumeFetchBudget(b, 2)).toBe(false);
  });

  it('allows all when limit is 0', async () => {
    const b = new LocalBudgetTracker();
    expect(await consumeFetchBudget(b, 0)).toBe(true);
    expect(await consumeFetchBudget(b, 0)).toBe(true);
  });
});

describe('LocalFetchDedupe', () => {
  it('blocks within window', async () => {
    const d = new LocalFetchDedupe();
    expect(await d.tryAcquire('x', 5000)).toBe(true);
    expect(await d.tryAcquire('x', 5000)).toBe(false);
  });
});
