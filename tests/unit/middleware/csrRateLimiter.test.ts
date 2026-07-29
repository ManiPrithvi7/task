import type { Request, Response, NextFunction } from 'express';
import { csrRateLimiter, resetCsrLocalCounters } from '@/middleware/csrRateLimiter';
import { resetCsrRateLimitScriptSha } from '@/middleware/csrRateLimitLua';

jest.mock('@/services/redisService', () => ({
  getRedisService: jest.fn()
}));
jest.mock('@/services/auditService', () => ({
  getAuditService: () => null,
  AuditEventType: { CSR_RATE_LIMITED: 'CSR_RATE_LIMITED' }
}));

import { getRedisService } from '@/services/redisService';

const mockGetRedis = getRedisService as jest.MockedFunction<typeof getRedisService>;

function mockRes(): Response & { statusCode: number; body: unknown; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    body: null as unknown,
    headers,
    set(k: string, v: string) {
      headers[k] = v;
      return res;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    }
  };
  return res as unknown as Response & {
    statusCode: number;
    body: unknown;
    headers: Record<string, string>;
  };
}

describe('csrRateLimiter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetCsrLocalCounters();
    resetCsrRateLimitScriptSha();
    mockGetRedis.mockReturnValue(null);
  });

  it('allows when under limits with Redis Lua', async () => {
    const evalSha = jest.fn().mockResolvedValue([1, 0, '', 0, 0]);
    const scriptLoad = jest.fn().mockResolvedValue('sha1');
    mockGetRedis.mockReturnValue({
      isRedisConnected: () => true,
      getClient: () => ({ evalSha, scriptLoad })
    } as never);

    const mw = csrRateLimiter({
      globalLimit: 100,
      perIpLimit: 5,
      provisionedLimit: 10,
      unprovisionedLimit: 3,
      windowSeconds: 900
    });
    const req = { ip: '1.2.3.4', body: { device_id: 'dev-1' } } as unknown as Request;
    const res = mockRes();
    const next = jest.fn() as NextFunction;

    await mw(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(evalSha).toHaveBeenCalledTimes(1);
  });

  it('maps Lua device block to per_device when device_id present', async () => {
    const evalSha = jest.fn().mockResolvedValue([0, 42, 'device', 11, 10]);
    mockGetRedis.mockReturnValue({
      isRedisConnected: () => true,
      getClient: () => ({
        evalSha,
        scriptLoad: jest.fn().mockResolvedValue('sha1')
      })
    } as never);

    const mw = csrRateLimiter({
      globalLimit: 100,
      perIpLimit: 5,
      provisionedLimit: 10,
      unprovisionedLimit: 3,
      windowSeconds: 900
    });
    const req = { ip: '1.2.3.4', body: { device_id: 'dev-1' } } as unknown as Request;
    const res = mockRes();
    const next = jest.fn() as NextFunction;

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
    expect(res.headers['X-RateLimit-Type']).toBe('per_device');
    expect(res.headers['X-RateLimit-Remaining']).toBe('0');
    expect((res.body as { type: string }).type).toBe('per_device');
  });

  it('maps Lua device block to unprovisioned when device_id absent', async () => {
    const evalSha = jest.fn().mockResolvedValue([0, 30, 'device', 4, 3]);
    mockGetRedis.mockReturnValue({
      isRedisConnected: () => true,
      getClient: () => ({
        evalSha,
        scriptLoad: jest.fn().mockResolvedValue('sha1')
      })
    } as never);

    const mw = csrRateLimiter({
      globalLimit: 100,
      perIpLimit: 5,
      provisionedLimit: 10,
      unprovisionedLimit: 3,
      windowSeconds: 900
    });
    const req = { ip: '1.2.3.4', body: {} } as unknown as Request;
    const res = mockRes();
    const next = jest.fn() as NextFunction;

    await mw(req, res, next);

    expect(res.statusCode).toBe(429);
    expect(res.headers['X-RateLimit-Type']).toBe('unprovisioned');
  });

  it('returns global 429 from Lua', async () => {
    const evalSha = jest.fn().mockResolvedValue([0, 55, 'global', 101, 100]);
    mockGetRedis.mockReturnValue({
      isRedisConnected: () => true,
      getClient: () => ({
        evalSha,
        scriptLoad: jest.fn().mockResolvedValue('sha1')
      })
    } as never);

    const mw = csrRateLimiter({
      globalLimit: 100,
      perIpLimit: 5,
      provisionedLimit: 10,
      unprovisionedLimit: 3,
      windowSeconds: 900
    });
    const req = { ip: '1.2.3.4', body: { device_id: 'dev-1' } } as unknown as Request;
    const res = mockRes();
    const next = jest.fn() as NextFunction;

    await mw(req, res, next);

    expect(res.statusCode).toBe(429);
    expect(res.headers['X-RateLimit-Type']).toBe('global');
    expect(res.headers['X-RateLimit-Remaining']).toBe('0');
    expect(evalSha).toHaveBeenCalledTimes(1);
  });

  it('returns per_ip 429 from Lua', async () => {
    const evalSha = jest.fn().mockResolvedValue([0, 100, 'per_ip', 6, 5]);
    mockGetRedis.mockReturnValue({
      isRedisConnected: () => true,
      getClient: () => ({
        evalSha,
        scriptLoad: jest.fn().mockResolvedValue('sha1')
      })
    } as never);

    const mw = csrRateLimiter({
      globalLimit: 100,
      perIpLimit: 5,
      provisionedLimit: 10,
      unprovisionedLimit: 3,
      windowSeconds: 900
    });
    const req = { ip: '9.9.9.9', body: { device_id: 'dev-1' } } as unknown as Request;
    const res = mockRes();
    const next = jest.fn() as NextFunction;

    await mw(req, res, next);

    expect(res.headers['X-RateLimit-Type']).toBe('per_ip');
  });

  it('fails open on Lua error without calling incr', async () => {
    const incr = jest.fn();
    const evalSha = jest.fn().mockRejectedValue(new Error('SCRIPT KILL'));
    mockGetRedis.mockReturnValue({
      isRedisConnected: () => true,
      getClient: () => ({
        evalSha,
        scriptLoad: jest.fn().mockResolvedValue('sha1'),
        incr
      })
    } as never);

    const mw = csrRateLimiter();
    const req = { ip: '1.2.3.4', body: { device_id: 'dev-1' } } as unknown as Request;
    const res = mockRes();
    const next = jest.fn() as NextFunction;

    await mw(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(incr).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('uses local Map when Redis unavailable and eventually 429s', async () => {
    mockGetRedis.mockReturnValue(null);

    const mw = csrRateLimiter({
      globalLimit: 2,
      perIpLimit: 100,
      provisionedLimit: 100,
      unprovisionedLimit: 100,
      windowSeconds: 900
    });
    const req = { ip: '1.2.3.4', body: { device_id: 'dev-1' } } as unknown as Request;

    const next1 = jest.fn() as NextFunction;
    await mw(req, mockRes(), next1);
    expect(next1).toHaveBeenCalled();

    const next2 = jest.fn() as NextFunction;
    await mw(req, mockRes(), next2);
    expect(next2).toHaveBeenCalled();

    const res3 = mockRes();
    const next3 = jest.fn() as NextFunction;
    await mw(req, res3, next3);
    expect(next3).not.toHaveBeenCalled();
    expect(res3.statusCode).toBe(429);
    expect(res3.headers['X-RateLimit-Type']).toBe('global');
  });
});
