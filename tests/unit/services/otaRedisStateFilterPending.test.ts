import { beforeEach, describe, expect, it } from 'bun:test';
import { OtaRedisState } from '@/services/otaService';
import {
  getLocalOtaFleetTracker,
  resetLocalOtaFleetTrackerForTests
} from '@/services/igPollCoordination';

describe('OtaRedisState.filterPending (local fleet)', () => {
  beforeEach(() => {
    resetLocalOtaFleetTrackerForTests();
  });

  it('returns empty when pending set is empty', async () => {
    const state = new OtaRedisState(() => null, 'proof-mqtt:');
    await expect(state.filterPending('1.0.0', ['a', 'b', 'c'])).resolves.toEqual([]);
  });

  it('returns empty when deviceIds empty', async () => {
    getLocalOtaFleetTracker().seedPendingFleet('1.0.0', ['a']);
    const state = new OtaRedisState(() => null, 'proof-mqtt:');
    await expect(state.filterPending('1.0.0', [])).resolves.toEqual([]);
  });

  it('filters to local pending members only', async () => {
    getLocalOtaFleetTracker().seedPendingFleet('1.2.3', ['d1', 'd3']);
    const state = new OtaRedisState(() => null, 'proof-mqtt:');
    const out = await state.filterPending('1.2.3', ['d1', 'd2', 'd3']);
    expect(out).toEqual(['d1', 'd3']);
  });

  it('returns empty when no overlap with pending set', async () => {
    getLocalOtaFleetTracker().seedPendingFleet('1.0.0', ['x']);
    const state = new OtaRedisState(() => null, 'proof-mqtt:');
    await expect(state.filterPending('1.0.0', ['a', 'b'])).resolves.toEqual([]);
  });
});
