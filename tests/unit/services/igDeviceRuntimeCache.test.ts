import { describe, expect, it, beforeEach } from 'bun:test';
import {
  getIgDeviceRuntimeCache,
  resetIgDeviceRuntimeCacheForTests
} from '../../../src/services/igDeviceRuntimeCache';

describe('IgDeviceRuntimeCache GMB index', () => {
  beforeEach(() => {
    resetIgDeviceRuntimeCacheForTests();
  });

  it('indexes and unindexes by gmbProfileId', () => {
    const cache = getIgDeviceRuntimeCache();
    cache.set('d1', { gmbProfileId: 'loc-1', gmbReviewCount: 10 });
    cache.set('d2', { gmbProfileId: 'loc-1', gmbReviewCount: 10 });
    cache.set('d3', { gmbProfileId: 'loc-2' });

    expect(cache.getByGmbProfileId('loc-1').sort()).toEqual(['d1', 'd2']);
    expect(cache.getByGmbProfileId('loc-2')).toEqual(['d3']);

    cache.delete('d1');
    expect(cache.getByGmbProfileId('loc-1')).toEqual(['d2']);

    cache.set('d2', { gmbProfileId: 'loc-2' });
    expect(cache.getByGmbProfileId('loc-1')).toEqual([]);
    expect(cache.getByGmbProfileId('loc-2').sort()).toEqual(['d2', 'd3']);
  });

  it('hydrateFromHashFields updates index', () => {
    const cache = getIgDeviceRuntimeCache();
    cache.hydrateFromHashFields('d1', {
      gmb_profile_id: 'loc-a',
      gmb_review_count: '5',
      ota_status: 'pending'
    });
    expect(cache.getByGmbProfileId('loc-a')).toEqual(['d1']);
    expect(cache.getOtaStatus('d1')).toBe('pending');
  });
});
