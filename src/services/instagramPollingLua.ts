import { RedisClientType } from 'redis';

export const REDIS_KEYS = {
  fullActiveSet: 'full_active_set',
  priorityZset: 'priority_zset',
  circuitBlockedUntil: 'instagram:circuit:blocked_until',
  deviceFollowers: (deviceId: string) => `device:followers:${deviceId}`,
  deviceFetchHistory: (deviceId: string) => `device:fetch_history:${deviceId}`,
  /** Firmware/device deferred background polling (Phase G); TTL refreshed on MQTT /active payload. */
  igPowerSave: (deviceId: string) => `ig:power_save:${deviceId}`,
  /** Round-robin cursor for background device fairness (Phase C). */
  backgroundFairnessOffset: 'ig:bg:fair_offset'
} as const;

/**
 * KEYS[1] = priority_zset
 * ARGV[1] = NOW (milliseconds)
 * Returns: active device IDs (score > NOW), and prunes expired (score <= NOW)
 */
export const atomicPriorityReadAndPruneLua = `
local active = redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], '+inf')
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
return active
`.trim();

/**
 * KEYS[1] = device:fetch_history:{id}
 * ARGV[1] = NOW (ms)
 * ARGV[2] = UUID
 * ARGV[3] = threshold (e.g. 6)
 * ARGV[4] = window_ms (e.g. 60000)
 * Returns: 1 if allowed+recorded, 0 if rate limited
 */
export const atomicBackoffCheckAndRecordLua = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local uuid = ARGV[2]
local threshold = tonumber(ARGV[3])
local window = tonumber(ARGV[4])
local start = now - window

redis.call('ZREMRANGEBYSCORE', key, '-inf', start)
local count = redis.call('ZCOUNT', key, start, now)

if count >= threshold then
  return 0
end

redis.call('ZADD', key, now, uuid)
redis.call('EXPIRE', key, math.ceil(window/1000) + 1)
return 1
`.trim();

/**
 * KEYS[1] = full_active_set (SET)
 * KEYS[2] = priority_zset (ZSET)
 * ARGV[1] = NOW (ms)
 * Returns: array of background device IDs (active and not in active priority window)
 */
/**
 * KEYS[1] = per-minute budget key (e.g. ig:poll:global_fetch_budget:{minute})
 * ARGV[1] = max allowed count (0 = unlimited, caller should skip script)
 * Returns: 1 if slot granted, 0 if over limit (INCR rolled back)
 */
export const atomicFetchBudgetTryLua = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then
  redis.call('EXPIRE', KEYS[1], 120)
end
local lim = tonumber(ARGV[1])
if lim <= 0 then
  return 1
end
if c > lim then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
`.trim();

export const atomicBackgroundSubtractionLua = `
local cursor = '0'
local result = {}
local priority_map = {}

local active_priority = redis.call('ZRANGEBYSCORE', KEYS[2], ARGV[1], '+inf')
for _, device in ipairs(active_priority) do
  priority_map[device] = true
end

repeat
  local scan = redis.call('SSCAN', KEYS[1], cursor)
  cursor = scan[1]
  local devices = scan[2]
  for _, device in ipairs(devices) do
    if not priority_map[device] then
      table.insert(result, device)
    end
  end
until cursor == '0'

return result
`.trim();

export async function evalAtomicPriorityReadAndPrune(
  redis: RedisClientType,
  nowMs: number
): Promise<string[]> {
  const res = await redis.eval(atomicPriorityReadAndPruneLua, {
    keys: [REDIS_KEYS.priorityZset],
    arguments: [String(nowMs)]
  });
  return Array.isArray(res) ? (res as string[]) : [];
}

export async function evalAtomicBackoffCheckAndRecord(
  redis: RedisClientType,
  deviceId: string,
  nowMs: number,
  uuid: string,
  threshold: number,
  windowMs: number
): Promise<boolean> {
  const res = await redis.eval(atomicBackoffCheckAndRecordLua, {
    keys: [REDIS_KEYS.deviceFetchHistory(deviceId)],
    arguments: [String(nowMs), uuid, String(threshold), String(windowMs)]
  });
  return String(res) === '1';
}

export async function evalAtomicBackgroundSubtraction(
  redis: RedisClientType,
  nowMs: number
): Promise<string[]> {
  const res = await redis.eval(atomicBackgroundSubtractionLua, {
    keys: [REDIS_KEYS.fullActiveSet, REDIS_KEYS.priorityZset],
    arguments: [String(nowMs)]
  });
  return Array.isArray(res) ? (res as string[]) : [];
}

