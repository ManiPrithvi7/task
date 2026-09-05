import { parseDashboardRange } from '@/utils/dashboardRange';

describe('parseDashboardRange', () => {
  it('accepts canonical ranges and the fallback', () => {
    expect(parseDashboardRange(undefined, '-90d')).toBe('-90d');
    expect(parseDashboardRange('-7d', '-90d')).toBe('-7d');
    expect(parseDashboardRange('-1d', '-7d')).toBe('-1d');
    expect(parseDashboardRange('-30d', '-7d')).toBe('-30d');
  });

  it('rejects enumerated or unknown ranges', () => {
    expect(parseDashboardRange('-90dT00:00:00Z', '-90d')).toBeNull();
    expect(parseDashboardRange('-2d', '-90d')).toBeNull();
    expect(parseDashboardRange('0', '-90d')).toBeNull();
  });
});
