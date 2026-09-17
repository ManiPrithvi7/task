import { metricsRouteLabel } from '@/middleware/metrics';

describe('metricsRouteLabel', () => {
  it('uses the Express route pattern when matched', () => {
    expect(metricsRouteLabel({ route: { path: '/dashboard/ig/:deviceId/summary' } })).toBe(
      '/dashboard/ig/:deviceId/summary'
    );
  });

  it('buckets unmatched / 404 paths as unmatched instead of raw URLs', () => {
    expect(metricsRouteLabel({})).toBe('unmatched');
    expect(metricsRouteLabel({ route: { path: undefined } })).toBe('unmatched');
  });
});
