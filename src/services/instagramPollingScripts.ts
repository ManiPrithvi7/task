import { RedisClientType } from 'redis';
import {
  REDIS_KEYS,
  atomicBackoffCheckAndRecordLua,
  atomicBackgroundSubtractionLua,
  atomicPriorityReadAndPruneLua
} from './instagramPollingLua';
import { logger } from '../utils/logger';

/** SHA digests returned by SCRIPT LOAD; reused with EVALSHA. */
export interface InstagramPollingScriptSha {
  priorityReadPrune: string;
  backoffCheckRecord: string;
  backgroundSubtract: string;
}

let loadedSha: InstagramPollingScriptSha | null = null;

function isNoScript(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('NOSCRIPT');
}

/** Load all three Lua scripts once per process (call after Redis connect). */
export async function loadInstagramPollingScripts(
  redis: RedisClientType,
  force = false
): Promise<InstagramPollingScriptSha> {
  if (loadedSha && !force) return loadedSha;

  const [priorityReadPrune, backoffCheckRecord, backgroundSubtract] = await Promise.all([
    redis.scriptLoad(atomicPriorityReadAndPruneLua),
    redis.scriptLoad(atomicBackoffCheckAndRecordLua),
    redis.scriptLoad(atomicBackgroundSubtractionLua)
  ]);

  loadedSha = { priorityReadPrune, backoffCheckRecord, backgroundSubtract };
  logger.info('[IG_POLLING_SCRIPTS] Loaded Lua scripts for EVALSHA', {
    priorityReadPrune,
    backoffCheckRecord,
    backgroundSubtract,
    forceReload: force
  });
  return loadedSha;
}

async function evalShaWithFallback(
  redis: RedisClientType,
  pickSha: (s: InstagramPollingScriptSha) => string,
  keys: string[],
  arguments_: string[]
): Promise<unknown> {
  let registry = await loadInstagramPollingScripts(redis);
  try {
    return await redis.evalSha(pickSha(registry), { keys, arguments: arguments_ });
  } catch (err: unknown) {
    if (!isNoScript(err)) throw err;
    registry = await loadInstagramPollingScripts(redis, true);
    return redis.evalSha(pickSha(registry), { keys, arguments: arguments_ });
  }
}

export async function evalAtomicPriorityReadAndPruneEvalSha(
  redis: RedisClientType,
  nowMs: number
): Promise<string[]> {
  const res = await evalShaWithFallback(
    redis,
    (s) => s.priorityReadPrune,
    [REDIS_KEYS.priorityZset],
    [String(nowMs)]
  );
  return Array.isArray(res) ? (res as string[]) : [];
}

export async function evalAtomicBackoffCheckAndRecordEvalSha(
  redis: RedisClientType,
  deviceId: string,
  nowMs: number,
  uuid: string,
  threshold: number,
  windowMs: number
): Promise<boolean> {
  const res = await evalShaWithFallback(
    redis,
    (s) => s.backoffCheckRecord,
    [REDIS_KEYS.deviceFetchHistory(deviceId)],
    [String(nowMs), uuid, String(threshold), String(windowMs)]
  );
  return String(res) === '1';
}

export async function evalAtomicBackgroundSubtractionEvalSha(
  redis: RedisClientType,
  nowMs: number
): Promise<string[]> {
  const res = await evalShaWithFallback(
    redis,
    (s) => s.backgroundSubtract,
    [REDIS_KEYS.fullActiveSet, REDIS_KEYS.priorityZset],
    [String(nowMs)]
  );
  return Array.isArray(res) ? (res as string[]) : [];
}

/** Tests / tooling: reset cached SHAs so next load hits Redis SCRIPT LOAD again. */
export function resetInstagramPollingScriptsCache(): void {
  loadedSha = null;
}

export function getInstagramPollingScriptSha(): InstagramPollingScriptSha | null {
  return loadedSha;
}
