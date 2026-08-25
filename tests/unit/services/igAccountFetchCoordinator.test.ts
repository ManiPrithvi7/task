import {
  getIgAccountFetchCoordinator,
  resetIgAccountFetchCoordinatorForTests
} from '../../../src/services/igAccountFetchCoordinator';

describe('igAccountFetchCoordinator', () => {
  beforeEach(() => {
    resetIgAccountFetchCoordinatorForTests();
  });

  it('returns cache_hit within 60s fresh window', () => {
    const c = getIgAccountFetchCoordinator();
    c.recordFetch('ig-1', 'scheduled', { followersCount: 100 });
    const d = c.decideFetch('ig-1', 'scheduled');
    expect(d.action).toBe('cache_hit');
    if (d.action === 'cache_hit') {
      expect(d.followersCount).toBe(100);
    }
  });

  it('allows fetch after fresh window expires', () => {
    const c = getIgAccountFetchCoordinator();
    c.recordFetch('ig-1', 'scheduled', { followersCount: 100 });
    const cached = c.getCached('ig-1')!;
    cached.fetchedAtMs = Date.now() - 61_000;
    expect(c.decideFetch('ig-1', 'scheduled').action).toBe('fetch');
  });

  it('enforces cron hourly cap', () => {
    const c = getIgAccountFetchCoordinator();
    for (let i = 0; i < 60; i++) {
      expect(c.decideFetch('ig-1', 'scheduled').action).toBe('fetch');
      c.recordFetch('ig-1', 'scheduled', { followersCount: 100 + i });
      const cached = c.getCached('ig-1')!;
      cached.fetchedAtMs = Date.now() - 61_000;
    }
    const d = c.decideFetch('ig-1', 'scheduled');
    expect(d.action).toBe('cache_hit');
  });

  it('purges account state', () => {
    const c = getIgAccountFetchCoordinator();
    c.recordFetch('ig-1', 'connect', { followersCount: 50 });
    c.purge('ig-1');
    expect(c.getCached('ig-1')).toBeNull();
    expect(c.decideFetch('ig-1', 'connect').action).toBe('fetch');
  });
});
