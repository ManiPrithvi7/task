export interface DateBucketResult {
  dateKey: string;
  ttlSeconds: number;
}

export const resolveMetricsTimezone = (): string =>
  process.env.METRICS_TIMEZONE || 'Asia/Kolkata';

export const priceToCents = (amount: string): number => {
  const trimmed = amount.trim();
  if (!trimmed) throw new Error('amount required');

  const [wholePart, fracPartRaw = ''] = trimmed.split('.');
  if (!wholePart || wholePart.startsWith('-')) {
    throw new Error('invalid amount');
  }

  const whole = Number.parseInt(wholePart, 10);
  if (!Number.isFinite(whole)) throw new Error('invalid amount');

  const fracPart = fracPartRaw.padEnd(2, '0').slice(0, 2);
  const frac = Number.parseInt(fracPart, 10);
  if (!Number.isFinite(frac)) throw new Error('invalid amount');

  return whole * 100 + frac;
};

/** Date key yyyy-MM-dd in timezone; TTL until next local midnight. */
export const getDateBucket = (isoTimestamp: string, timezone: string): DateBucketResult => {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) throw new Error('invalid timestamp');

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const dateKey = formatter.format(date);

  const parts = formatter.formatToParts(date);
  const y = Number(parts.find((p) => p.type === 'year')?.value);
  const m = Number(parts.find((p) => p.type === 'month')?.value);
  const d = Number(parts.find((p) => p.type === 'day')?.value);

  const nextLocalMidnightUtc = Date.UTC(y, m - 1, d + 1, 0, 0, 0);
  const offsetMs = getTimezoneOffsetMs(date, timezone);
  const nextMidnightUtc = nextLocalMidnightUtc - offsetMs;

  const ttlMs = nextMidnightUtc - date.getTime();
  const ttlSeconds = Math.max(1, Math.floor(ttlMs / 1000));

  return { dateKey, ttlSeconds };
};

function getTimezoneOffsetMs(at: Date, timeZone: string): number {
  const utc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }));
  const zoned = new Date(at.toLocaleString('en-US', { timeZone }));
  return zoned.getTime() - utc.getTime();
}

export interface DailyMetricsRedisKeys {
  setKey: string;
  countKey: string;
  revenueCentsKey: string;
  lastKey: string;
}

export const getDailyMetricsKeys = (userId: string, dateKey: string): DailyMetricsRedisKeys => {
  const base = `metrics:orders:${userId}:${dateKey}`;
  return {
    setKey: `${base}:set`,
    countKey: `${base}:count`,
    revenueCentsKey: `${base}:revenue_cents`,
    lastKey: `${base}:last`
  };
};

/** Start of calendar day in `timezone` for instant `at` (for Influx range queries). */
export function getStartOfDayInTimezone(at: Date, timezone: string): Date {
  if (Number.isNaN(at.getTime())) throw new Error('invalid timestamp');

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const dateKey = formatter.format(at);
  const [y, m, d] = dateKey.split('-').map((n) => Number(n));
  const offsetMs = getTimezoneOffsetMs(at, timezone);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMs);
}

export function getDateKeyForInstant(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(at);
}

/** Write-through cache for POS daily totals (Influx is source of truth). */
export function getPosDailyCacheKeys(userId: string, dateKey: string): {
  countKey: string;
  topSellerKey: string;
} {
  const base = `cache:pos:daily:${userId}:${dateKey}`;
  return {
    countKey: base,
    topSellerKey: `${base}:top_seller`
  };
}

const POS_DAILY_CACHE_TTL_SEC = 300;

export function getPosDailyCacheTtlSec(): number {
  return POS_DAILY_CACHE_TTL_SEC;
}

/** Escape user-controlled strings embedded in Flux queries. */
export function escapeFluxString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
