import { describe, expect, it, beforeEach } from 'bun:test';
import {
  LocalBudgetTracker,
  LocalDeviceBackoff,
  LocalFetchDedupe,
  LocalOtaFleetTracker,
  consumeFetchBudget,
  resetLocalOtaFleetTrackerForTests
} from '../../../src/services/igPollCoordination';
import {
  LocalConnectDebounce,
  LocalPromoRotationCache,
  LocalPublishHashCache,
  LocalStimLock,
  LocalTtlCache,
  resetLocalCachesForTests
} from '../../../src/services/localCaches';

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

describe('LocalOtaFleetTracker', () => {
  beforeEach(() => {
    resetLocalOtaFleetTrackerForTests();
  });

  it('FIFO + version rotation selects rollout window', () => {
    const statuses = new Map<string, string>();
    const tracker = new LocalOtaFleetTracker((id) => statuses.get(id));
    const registeredAt = new Map([
      ['a', 100],
      ['b', 200],
      ['c', 300],
      ['d', 400]
    ]);
    tracker.setActiveDevices(['a', 'b', 'c', 'd'], registeredAt);

    // 50% of 4 = 2 devices; version 1.0 → offset (100+0)%4 = 0 → a,b
    expect(tracker.getDevicesForRollout(50, '1.0.0')).toEqual(['a', 'b']);

    // version 1.1 → offset 101%4 = 1 → b,c (rotated)
    expect(tracker.getDevicesForRollout(50, '1.1.0')).toEqual(['b', 'c']);
  });

  it('excludes succeeded/delivered from rollout', () => {
    const statuses = new Map<string, string>([['a', 'succeeded'], ['b', 'delivered']]);
    const tracker = new LocalOtaFleetTracker((id) => statuses.get(id));
    tracker.setActiveDevices(['a', 'b', 'c'], new Map([['a', 1], ['b', 2], ['c', 3]]));
    expect(tracker.getDevicesForRollout(100, '1.0.0')).toEqual(['c']);
  });

  it('tracks pending and delivered', async () => {
    const tracker = new LocalOtaFleetTracker();
    await tracker.markPending('d1', '1.2.0', 25);
    expect(await tracker.isPending('d1', '1.2.0')).toBe(true);
    await tracker.markDelivered('d1', '1.2.0');
    expect(await tracker.isPending('d1', '1.2.0')).toBe(false);
    expect(await tracker.isDelivered('d1', '1.2.0')).toBe(true);
  });
});

describe('localCaches', () => {
  beforeEach(() => {
    resetLocalCachesForTests();
  });

  it('LocalTtlCache expires', () => {
    const c = new LocalTtlCache<string>();
    c.set('k', 'v', 60_000);
    expect(c.get('k')).toBe('v');
    c.del('k');
    expect(c.get('k')).toBeNull();
  });

  it('LocalStimLock acquire/refresh/release', () => {
    const lock = new LocalStimLock();
    expect(lock.tryAcquire('d1', 'ig', 5000)).toBe(true);
    expect(lock.tryAcquire('d1', 'ig', 5000)).toBe(false);
    expect(lock.isLocked('d1', 'ig')).toBe(true);
    lock.release('d1', 'ig');
    expect(lock.isLocked('d1', 'ig')).toBe(false);
  });

  it('LocalPublishHashCache clears by device', () => {
    const c = new LocalPublishHashCache();
    c.set('d1', 'stats', 'abc', 60_000);
    c.set('d2', 'stats', 'def', 60_000);
    c.clear('d1');
    expect(c.get('d1', 'stats')).toBeNull();
    expect(c.get('d2', 'stats')).toBe('def');
  });

  it('LocalPromoRotationCache increments', () => {
    const r = new LocalPromoRotationCache();
    expect(r.get('d1')).toBe(0);
    expect(r.increment('d1')).toBe(1);
    expect(r.increment('d1')).toBe(2);
  });

  it('LocalConnectDebounce gates refresh', () => {
    const d = new LocalConnectDebounce();
    expect(d.shouldRefresh('x', 5000)).toBe(true);
    expect(d.shouldRefresh('x', 5000)).toBe(false);
  });
});
