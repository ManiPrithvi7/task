import { describe, expect, it, jest, beforeEach, afterEach } from 'bun:test';
import {
  InstagramPoller,
  resetInstagramPollingScriptsCache,
  evalAtomicPriorityReadAndPruneEvalSha,
  loadInstagramPollingScripts
} from '@/services/instagramService';

const baseConfig = {
  priorityIntervalMs: 60_000,
  backgroundIntervalMs: 60_000,
  priorityTtlMs: 300_000,
  batchSize: 4,
  backoffThreshold: 3,
  backoffWindowMs: 60_000,
  priorityCapPerCycle: 0,
  fetchDedupeWindowMs: 1000,
  priorityZsetMaxMembers: 0,
  priorityRefreshMaxDeltaMs: 0,
  priorityAbsoluteMaxFutureMs: 0,
  backgroundCapPerCycle: 0,
  backgroundFairRotate: true,
  globalFetchBudgetPerMinute: 100,
  useLocalCircuit: true,
  useLocalBackoff: true,
  useLocalBudget: true,
  useLocalDedupe: true,
  useLocalFairOffset: true
};

function makeRedisService(client: Record<string, ReturnType<typeof jest.fn>>) {
  return {
    isRedisConnected: () => true,
    getClient: () => client
  } as never;
}

describe('InstagramPoller priority EVALSHA gate', () => {
  let evalSpy: ReturnType<typeof jest.spyOn>;
  let loadSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    resetInstagramPollingScriptsCache();
    evalSpy = jest.spyOn(
      { evalAtomicPriorityReadAndPruneEvalSha },
      'evalAtomicPriorityReadAndPruneEvalSha'
    );
    loadSpy = jest.spyOn({ loadInstagramPollingScripts }, 'loadInstagramPollingScripts');
  });

  afterEach(() => {
    evalSpy.mockRestore();
    loadSpy.mockRestore();
  });

  it('skips EVALSHA when local priority queue size is 0', async () => {
    const mod = await import('@/services/instagramService');
    loadSpy = jest.spyOn(mod, 'loadInstagramPollingScripts').mockResolvedValue({ priorityReadPrune: 'sha1' });
    evalSpy = jest.spyOn(mod, 'evalAtomicPriorityReadAndPruneEvalSha').mockResolvedValue([]);

    const client = {
      zCard: jest.fn().mockResolvedValue(0),
      zScore: jest.fn().mockResolvedValue(null),
      zAdd: jest.fn().mockResolvedValue(1)
    };

    const poller = new InstagramPoller(
      { isConfigured: () => true, invokeFetch: jest.fn().mockResolvedValue(true) },
      makeRedisService(client),
      baseConfig
    );

    await poller.start();
    await (poller as unknown as { priorityScheduler(): Promise<void> }).priorityScheduler();

    expect(evalSpy).not.toHaveBeenCalled();
    poller.stop();
  });

  it('runs EVALSHA after markPriority adds a new member', async () => {
    const mod = await import('@/services/instagramService');
    loadSpy = jest.spyOn(mod, 'loadInstagramPollingScripts').mockResolvedValue({ priorityReadPrune: 'sha1' });
    evalSpy = jest.spyOn(mod, 'evalAtomicPriorityReadAndPruneEvalSha').mockResolvedValue(['DEVICE-1']);

    const client = {
      zCard: jest.fn().mockResolvedValueOnce(0).mockResolvedValue(1),
      zScore: jest.fn().mockResolvedValue(null),
      zAdd: jest.fn().mockResolvedValue(1)
    };

    const poller = new InstagramPoller(
      { isConfigured: () => true, invokeFetch: jest.fn().mockResolvedValue(true) },
      makeRedisService(client),
      baseConfig
    );

    await poller.start();
    await poller.markPriority('DEVICE-1');
    await (poller as unknown as { priorityScheduler(): Promise<void> }).priorityScheduler();

    expect(evalSpy).toHaveBeenCalledTimes(1);
    poller.stop();
  });
});
