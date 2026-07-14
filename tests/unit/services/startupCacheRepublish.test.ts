import { describe, expect, it } from 'bun:test';
import { devicesNeedingHydration } from '../../../src/services/startupCacheRepublish';

describe('devicesNeedingHydration', () => {
  it('returns redis members missing from local set', () => {
    expect(devicesNeedingHydration(['a', 'b', 'c'], new Set(['b']))).toEqual(['a', 'c']);
  });

  it('drops blank members', () => {
    expect(devicesNeedingHydration(['  ', 'x', ''], new Set())).toEqual(['x']);
  });

  it('returns empty when all already local', () => {
    expect(devicesNeedingHydration(['a'], new Set(['a']))).toEqual([]);
  });
});
