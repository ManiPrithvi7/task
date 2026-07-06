import { createHash } from 'crypto';
import { IG_PROFILE_API_ENDPOINT } from '@/lib/socials/instagramMetrics';

describe('instagram metrics audit constants', () => {
  it('uses graph.instagram.com/me as api endpoint tag value', () => {
    expect(IG_PROFILE_API_ENDPOINT).toBe('graph.instagram.com/me');
  });

  it('sha256 is stable for compliance hashing', () => {
    const body = '{"followers_count":100,"media_count":5}';
    const hash = createHash('sha256').update(body, 'utf8').digest('hex');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });
});
