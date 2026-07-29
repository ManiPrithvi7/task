/**
 * CSR rate-limit Lua (short-circuit EVALSHA).
 * One client command per /sign-csr when Redis is up.
 */

import type { RedisClientType } from 'redis';
import { logger } from '../utils/logger';

export const CSR_RATE_LIMIT_LUA = `
-- csrRateLimitLua v1
-- KEYS[1]=global KEYS[2]=ip KEYS[3]=deviceOrUnprov
-- ARGV[1]=globalLimit ARGV[2]=ipLimit ARGV[3]=deviceLimit
-- ARGV[4]=globalWindow ARGV[5]=ipWindow ARGV[6]=deviceWindow
-- Returns: { allowed(0|1), retryAfter, limitType, count, limit }
-- limitType: "global" | "per_ip" | "device"
local function bump(key, window)
  local c = redis.call('INCR', key)
  if c == 1 then redis.call('EXPIRE', key, window) end
  local ttl = redis.call('TTL', key)
  if ttl < 0 then ttl = window end
  return c, ttl
end

local gl, il, dl = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local gw, iw, dw = tonumber(ARGV[4]), tonumber(ARGV[5]), tonumber(ARGV[6])

local c, ttl = bump(KEYS[1], gw)
if c > gl then return {0, ttl, 'global', c, gl} end

c, ttl = bump(KEYS[2], iw)
if c > il then return {0, ttl, 'per_ip', c, il} end

c, ttl = bump(KEYS[3], dw)
if c > dl then return {0, ttl, 'device', c, dl} end

return {1, 0, '', 0, 0}
`.trim();

export type CsrRateLimitLuaResult = {
  allowed: boolean;
  retryAfter: number;
  limitType: 'global' | 'per_ip' | 'device' | '';
  count: number;
  limit: number;
};

let cachedSha: string | null = null;

function isNoScript(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('NOSCRIPT');
}

export async function loadCsrRateLimitScript(
  redis: RedisClientType,
  force = false
): Promise<string> {
  if (cachedSha && !force) return cachedSha;
  cachedSha = await redis.scriptLoad(CSR_RATE_LIMIT_LUA);
  logger.info('[CSR_RATE_LIMIT_LUA] Loaded script for EVALSHA', {
    sha: cachedSha,
    forceReload: force
  });
  return cachedSha;
}

/** Clear cached SHA (tests). */
export function resetCsrRateLimitScriptSha(): void {
  cachedSha = null;
}

function parseLuaResult(raw: unknown): CsrRateLimitLuaResult {
  const arr = Array.isArray(raw) ? raw : [];
  const allowed = Number(arr[0]) === 1;
  const retryAfter = Number(arr[1]) || 0;
  const limitTypeRaw = String(arr[2] ?? '');
  const limitType =
    limitTypeRaw === 'global' || limitTypeRaw === 'per_ip' || limitTypeRaw === 'device'
      ? limitTypeRaw
      : '';
  const count = Number(arr[3]) || 0;
  const limit = Number(arr[4]) || 0;
  return { allowed, retryAfter, limitType, count, limit };
}

export async function evalCsrRateLimitSha(
  redis: RedisClientType,
  opts: {
    keys: [string, string, string];
    limits: [number, number, number];
    windows: [number, number, number];
  }
): Promise<CsrRateLimitLuaResult> {
  const arguments_ = [
    String(opts.limits[0]),
    String(opts.limits[1]),
    String(opts.limits[2]),
    String(opts.windows[0]),
    String(opts.windows[1]),
    String(opts.windows[2])
  ];

  let sha = await loadCsrRateLimitScript(redis);
  try {
    const raw = await redis.evalSha(sha, { keys: opts.keys, arguments: arguments_ });
    return parseLuaResult(raw);
  } catch (err: unknown) {
    if (!isNoScript(err)) throw err;
    sha = await loadCsrRateLimitScript(redis, true);
    const raw = await redis.evalSha(sha, { keys: opts.keys, arguments: arguments_ });
    return parseLuaResult(raw);
  }
}
