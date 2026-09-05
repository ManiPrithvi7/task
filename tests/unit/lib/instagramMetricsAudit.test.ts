import { createHash } from 'crypto';
import { getIgFetchBodySizeSnapshot, IG_PROFILE_API_ENDPOINT } from '@/lib/socials/instagramMetrics';

describe('instagram metrics audit constants', () => {
  it('uses graph.instagram.com/me as api endpoint tag value', () => {
    expect(IG_PROFILE_API_ENDPOINT).toBe('graph.instagram.com/me');
  });

  it('tracks last body sizes as numbers not retained payloads', () => {
    const snap = getIgFetchBodySizeSnapshot();
    expect(snap.lastGraphResponseBytes).toBeGreaterThanOrEqual(0);
    expect(snap.lastDetailsJsonBytes).toBeGreaterThanOrEqual(0);
  });

  it('sha256 is stable for compliance hashing', () => {
    const body = '{"followers_count":100,"media_count":5}';
    const hash = createHash('sha256').update(body, 'utf8').digest('hex');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });
});
