import { describe, expect, it, jest, beforeEach } from 'bun:test';
import { InstagramPoller, resetInstagramPollingScriptsCache, resetOutcomeCircuitForTests } from '@/services/instagramService';
import { isConnectBurstDevice } from '@/config/instagramPollingConfig';

const baseConfig = {
  priorityIntervalMs: 60_000,
  backgroundIntervalMs: 90_000,
  priorityTtlMs: 120_000,
  batchSize: 4,
  backoffThreshold: 6,
  backoffWindowMs: 60_000,
  priorityCapPerCycle: 0,
  fetchDedupeWindowMs: 45_000,
  priorityZsetMaxMembers: 0,
  priorityRefreshMaxDeltaMs: 0,
  priorityAbsoluteMaxFutureMs: 0,
  backgroundCapPerCycle: 0,
  backgroundFairRotate: true,
  globalFetchBudgetPerMinute: 0,
  useLocalCircuit: true,
  useLocalBackoff: true,
  useLocalBudget: true,
  useLocalDedupe: true,
  useLocalFairOffset: true
};

function makeRedis() {
  return {
    isRedisConnected: () => true,
    getClient: () => ({
      zCard: jest.fn().mockResolvedValue(0),
      zRem: jest.fn().mockResolvedValue(0)
    })
  } as never;
}

describe('isConnectBurstDevice', () => {
  it('matches only the hardcoded lab device', () => {
    expect(isConnectBurstDevice('274968B43A1D')).toBe(true);
    expect(isConnectBurstDevice('OTHER')).toBe(false);
  });
});

describe('InstagramPoller connect burst', () => {
  beforeEach(async () => {
    resetInstagramPollingScriptsCache();
    await resetOutcomeCircuitForTests();
  });

  async function startedPoller(invokeFetch: jest.Mock) {
    const mod = await import('@/services/instagramService');
    jest.spyOn(mod, 'loadInstagramPollingScripts').mockResolvedValue({ priorityReadPrune: 'sha' });
    const poller = new InstagramPoller(
      { isConfigured: () => true, invokeFetch },
      makeRedis(),
      baseConfig
    );
    await poller.start();
    return poller;
  }

  it('does not start a burst for a non-allowlisted device', async () => {
    const invokeFetch = jest.fn().mockResolvedValue(true);
    const poller = await startedPoller(invokeFetch);
    await poller.startConnectBurst('OTHER');
    expect(poller.hasConnectBurst('OTHER')).toBe(false);
    expect(invokeFetch).not.toHaveBeenCalled();
    poller.stop();
  });

  it('fetches immediately and every 10s, then stops at 90s', async () => {
    const invokeFetch = jest.fn().mockResolvedValue(true);
    const poller = await startedPoller(invokeFetch);
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const ticks: Array<() => void> = [];
    const realSetInterval = global.setInterval.bind(global);
    jest.spyOn(global, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === 10_000) {
        ticks.push(fn);
        return 1 as unknown as ReturnType<typeof setInterval>;
      }
      return realSetInterval(fn, ms as number);
    }) as typeof setInterval);

    await poller.startConnectBurst('274968B43A1D');
    expect(poller.hasConnectBurst('274968B43A1D')).toBe(true);
    expect(ticks).toHaveLength(1);
    expect(invokeFetch).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 8; i++) {
      now += 10_000;
      ticks[0]();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(invokeFetch.mock.calls.length).toBe(9);
    expect(poller.hasConnectBurst('274968B43A1D')).toBe(true);

    now += 10_000;
    ticks[0]();
    await Promise.resolve();
    expect(poller.hasConnectBurst('274968B43A1D')).toBe(false);
    expect(invokeFetch).toHaveBeenCalledTimes(9);
    poller.stop();
    jest.restoreAllMocks();
  });

  it('bypassDedupe allows a second fetch inside the 45s window', async () => {
    const invokeFetch = jest.fn().mockResolvedValue(true);
    const poller = await startedPoller(invokeFetch);
    const first = await poller.requestImmediateFetch('274968B43A1D', { trigger: 'connect' });
    const blocked = await poller.requestImmediateFetch('274968B43A1D', { trigger: 'connect' });
    const bypassed = await poller.requestImmediateFetch('274968B43A1D', {
      trigger: 'connect',
      bypassDedupe: true
    });
    expect(first).toBe(true);
    expect(blocked).toBe(false);
    expect(bypassed).toBe(true);
    expect(invokeFetch).toHaveBeenCalledTimes(2);
    poller.stop();
  });
});
