/** Ported from Statsnapp lib/redis/scripts/daily-metrics.ts */
export const DAILY_METRICS_LUA = `
local setKey = KEYS[1]
local countKey = KEYS[2]
local revenueKey = KEYS[3]
local lastKey = KEYS[4]
local checkoutId = ARGV[1]
local revenueCents = tonumber(ARGV[2])
local ttlSeconds = tonumber(ARGV[3])
local lastOrderJson = ARGV[4]
if (not checkoutId) or (checkoutId == '') then
  return redis.error_reply('checkoutId required')
end
if (not revenueCents) then
  return redis.error_reply('revenueCents must be integer')
end
if (not ttlSeconds) or (ttlSeconds < 1) then
  ttlSeconds = 1
end
local added = redis.call('SADD', setKey, checkoutId)
local count = redis.call('GET', countKey)
local revenue = redis.call('GET', revenueKey)
if (added == 1) then
  count = redis.call('INCR', countKey)
  revenue = redis.call('INCRBY', revenueKey, revenueCents)
  if (lastKey and lastKey ~= '' and lastOrderJson and lastOrderJson ~= '') then
    redis.call('SET', lastKey, lastOrderJson)
  end
else
  count = count or '0'
  revenue = revenue or '0'
end
redis.call('EXPIRE', setKey, ttlSeconds)
redis.call('EXPIRE', countKey, ttlSeconds)
redis.call('EXPIRE', revenueKey, ttlSeconds)
if (lastKey and lastKey ~= '') then
  redis.call('EXPIRE', lastKey, ttlSeconds)
end
return { added, tonumber(count), tonumber(revenue) }
`;
