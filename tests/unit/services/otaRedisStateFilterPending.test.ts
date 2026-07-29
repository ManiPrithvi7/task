import {
  OtaRedisState,
  SMISMEMBER_CHUNK_SIZE
} from '@/services/otaService';

describe('OtaRedisState.filterPending', () => {
  it('returns all deviceIds when Redis client is null', async () => {
    const state = new OtaRedisState(() => null, 'proof-mqtt:');
    const ids = ['a', 'b', 'c'];
    await expect(state.filterPending('1.0.0', ids)).resolves.toEqual(ids);
  });

  it('returns empty when deviceIds empty', async () => {
    const smIsMember = jest.fn();
    const state = new OtaRedisState(
      () => ({ smIsMember } as never),
      'proof-mqtt:'
    );
    await expect(state.filterPending('1.0.0', [])).resolves.toEqual([]);
    expect(smIsMember).not.toHaveBeenCalled();
  });

  it('filters with smIsMember results', async () => {
    const smIsMember = jest.fn().mockResolvedValue([true, false, true]);
    const state = new OtaRedisState(
      () => ({ smIsMember } as never),
      'proof-mqtt:'
    );
    const out = await state.filterPending('1.2.3', ['d1', 'd2', 'd3']);
    expect(out).toEqual(['d1', 'd3']);
    expect(smIsMember).toHaveBeenCalledWith('proof-mqtt:ota:pending:1.2.3', [
      'd1',
      'd2',
      'd3'
    ]);
  });

  it('returns empty when all flags are false (empty pending set)', async () => {
    const smIsMember = jest.fn().mockResolvedValue([false, false]);
    const state = new OtaRedisState(
      () => ({ smIsMember } as never),
      'proof-mqtt:'
    );
    await expect(state.filterPending('1.0.0', ['a', 'b'])).resolves.toEqual([]);
  });

  it('chunks calls when deviceIds exceed SMISMEMBER_CHUNK_SIZE', async () => {
    const ids = Array.from({ length: SMISMEMBER_CHUNK_SIZE + 3 }, (_, i) => `d${i}`);
    const smIsMember = jest
      .fn()
      .mockResolvedValueOnce(Array(SMISMEMBER_CHUNK_SIZE).fill(false))
      .mockResolvedValueOnce([true, false, true]);

    const state = new OtaRedisState(
      () => ({ smIsMember } as never),
      't:'
    );
    const out = await state.filterPending('9.9.9', ids);
    expect(smIsMember).toHaveBeenCalledTimes(2);
    expect(smIsMember.mock.calls[0][1]).toHaveLength(SMISMEMBER_CHUNK_SIZE);
    expect(smIsMember.mock.calls[1][1]).toHaveLength(3);
    expect(out).toEqual([
      ids[SMISMEMBER_CHUNK_SIZE],
      ids[SMISMEMBER_CHUNK_SIZE + 2]
    ]);
  });

  it('falls back to sequential sIsMember when smIsMember missing', async () => {
    const sIsMember = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const state = new OtaRedisState(
      () => ({ sIsMember } as never),
      'proof-mqtt:'
    );
    const out = await state.filterPending('1.0.0', ['a', 'b', 'c']);
    expect(out).toEqual(['a', 'c']);
    expect(sIsMember).toHaveBeenCalledTimes(3);
  });
});
