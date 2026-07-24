import { verifyPubSubPushRequest } from '@/lib/socials/gmb-pubsub';

describe('E2E GMB Pub/Sub verification stub', () => {
  it('allows push when skipAuthVerify is enabled outside production', async () => {
    const result = await verifyPubSubPushRequest(
      null,
      { skipAuthVerify: true, audience: 'https://example.com/api/webhooks/google-business-reviews' },
      false
    );
    expect(result.valid).toBe(true);
  });

  it('rejects push without bearer token when auth verify is required', async () => {
    const result = await verifyPubSubPushRequest(
      null,
      { skipAuthVerify: false, audience: 'https://example.com/api/webhooks/google-business-reviews' },
      true
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/No token provided/);
  });
});
