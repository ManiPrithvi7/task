/**
 * Gated CSR Lua integration test against a real Redis.
 * Skip unless REDIS_URL or CSR_LUA_INTEGRATION=1 is set.
 */

import { createClient, type RedisClientType } from 'redis';
import {
  CSR_RATE_LIMIT_LUA,
  evalCsrRateLimitSha,
  resetCsrRateLimitScriptSha
} from '@/middleware/csrRateLimitLua';

const run =
  Boolean(process.env.REDIS_URL?.trim()) || process.env.CSR_LUA_INTEGRATION === '1';

const describeOrSkip = run ? describe : describe.skip;

describeOrSkip('csrRateLimitLua integration', () => {
  let client: RedisClientType;
  const prefix = `csr:test:${Date.now()}:`;

  beforeAll(async () => {
    const url = process.env.REDIS_URL?.trim();
    if (!url) {
      throw new Error('REDIS_URL required for CSR Lua integration');
    }
    client = createClient({ url }) as RedisClientType;
    await client.connect();
    resetCsrRateLimitScriptSha();
  });

  afterAll(async () => {
    if (!client) return;
    const keys = await client.keys(`${prefix}*`);
    if (keys.length > 0) await client.del(keys);
    await client.quit();
  });

  beforeEach(async () => {
    const keys = await client.keys(`${prefix}*`);
    if (keys.length > 0) await client.del(keys);
    resetCsrRateLimitScriptSha();
  });

  it('loads script and allows first request', async () => {
    const sha = await client.scriptLoad(CSR_RATE_LIMIT_LUA);
    expect(sha).toBeTruthy();

    const globalKey = `${prefix}global`;
    const ipKey = `${prefix}ip`;
    const deviceKey = `${prefix}device`;

    const result = await evalCsrRateLimitSha(client, {
      keys: [globalKey, ipKey, deviceKey],
      limits: [100, 5, 10],
      windows: [60, 900, 900]
    });

    expect(result.allowed).toBe(true);
    expect(await client.get(globalKey)).toBe('1');
    expect(await client.get(ipKey)).toBe('1');
    expect(await client.get(deviceKey)).toBe('1');
  });

  it('short-circuits on global block without incrementing IP', async () => {
    const globalKey = `${prefix}global2`;
    const ipKey = `${prefix}ip2`;
    const deviceKey = `${prefix}device2`;

    await client.set(globalKey, '2');
    await client.expire(globalKey, 60);

    const result = await evalCsrRateLimitSha(client, {
      keys: [globalKey, ipKey, deviceKey],
      limits: [2, 5, 10],
      windows: [60, 900, 900]
    });

    expect(result.allowed).toBe(false);
    expect(result.limitType).toBe('global');
    expect(result.count).toBe(3);
    expect(result.retryAfter).toBeGreaterThan(0);
    expect(await client.get(ipKey)).toBeNull();
    expect(await client.get(deviceKey)).toBeNull();
  });
});
