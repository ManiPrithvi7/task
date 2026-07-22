/** Max valid InfluxDB timestamp in nanoseconds (signed int64). */
export const INFLUX_NS_MAX = 9_223_372_036_854_775_807n;

/** Reject timestamps before year 2000 in ns (~946684800000000000). */
const INFLUX_NS_MIN = 946_684_800_000_000_000n;

export function influxNsFromDate(date: Date): bigint {
  return BigInt(date.getTime()) * 1_000_000n;
}

export function isValidInfluxNs(ns: bigint): boolean {
  return ns >= INFLUX_NS_MIN && ns <= INFLUX_NS_MAX;
}

/**
 * Normalize device/event timestamps for Influx point.timestamp().
 * Never treats small integers (e.g. uptime seconds) as epoch values.
 */
export function normalizeInfluxTimestamp(input: Date | string | number | undefined | null): Date {
  if (input instanceof Date && !Number.isNaN(input.getTime())) {
    const ns = influxNsFromDate(input);
    if (isValidInfluxNs(ns)) return input;
  }

  if (typeof input === 'string' && input.trim()) {
    const parsed = Date.parse(input);
    if (!Number.isNaN(parsed)) {
      const d = new Date(parsed);
      if (isValidInfluxNs(influxNsFromDate(d))) return d;
    }
  }

  if (typeof input === 'number' && Number.isFinite(input)) {
    // ISO ms (13 digits) or ns (19 digits) only — reject small values like uptime.
    if (input >= 1_000_000_000_000 && input < 1_000_000_000_000_000) {
      const d = new Date(input);
      if (isValidInfluxNs(influxNsFromDate(d))) return d;
    }
    if (input >= 1_000_000_000_000_000_000) {
      const ms = Math.floor(input / 1_000_000);
      const d = new Date(ms);
      if (isValidInfluxNs(influxNsFromDate(d))) return d;
    }
  }

  return new Date();
}

/** Parse trailing timestamp token from Influx line protocol. */
export function parseLineProtocolTimestampNs(line: string): bigint | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const lastSpace = trimmed.lastIndexOf(' ');
  if (lastSpace <= 0) return null;
  const token = trimmed.slice(lastSpace + 1);
  if (!/^\d+$/.test(token)) return null;
  try {
    return BigInt(token);
  } catch {
    return null;
  }
}

/** Replace invalid trailing timestamp with current time in ns. */
export function sanitizeInfluxLineProtocol(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const ns = parseLineProtocolTimestampNs(trimmed);
  if (ns === null) return trimmed;

  if (isValidInfluxNs(ns)) return trimmed;

  const withoutTs = trimmed.slice(0, trimmed.lastIndexOf(' '));
  const fixedNs = influxNsFromDate(new Date()).toString();
  return `${withoutTs} ${fixedNs}`;
}
