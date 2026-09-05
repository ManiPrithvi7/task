export const DASHBOARD_RANGES = new Set(['-1d', '-7d', '-30d', '-90d']);

export function parseDashboardRange(raw: unknown, fallback: string): string | null {
  const v = raw == null || raw === '' ? fallback : String(raw);
  return DASHBOARD_RANGES.has(v) ? v : null;
}
