import { tryClaimWebhookDedupe } from '@/webhooks/dedupe/redisDedupe';

jest.mock('@/services/redisService', () => ({
  getRedisService: () => null
}));

describe('redisDedupe', () => {
  it('allows processing when Redis is unavailable', async () => {
    const ok = await tryClaimWebhookDedupe('gmb:acct:loc:review1');
    expect(ok).toBe(true);
  });
});
