import {
  normalizeInfluxTimestamp,
  parseLineProtocolTimestampNs,
  sanitizeInfluxLineProtocol,
  isValidInfluxNs
} from '@/utils/influxTimestamp';

describe('influxTimestamp', () => {
  it('rejects uptime-sized values as timestamps', () => {
    const d = normalizeInfluxTimestamp(20);
    expect(d.getTime()).toBeGreaterThan(1_000_000_000_000);
  });

  it('rejects poison-pill ns timestamp from production logs', () => {
    const line =
      'device_ota_events,device_id=DEVICE-15,event=status uptime_s=20i 593807155200000000000';
    const ns = parseLineProtocolTimestampNs(line);
    expect(ns).not.toBeNull();
    expect(isValidInfluxNs(ns!)).toBe(false);

    const fixed = sanitizeInfluxLineProtocol(line)!;
    const fixedNs = parseLineProtocolTimestampNs(fixed);
    expect(fixedNs).not.toBeNull();
    expect(isValidInfluxNs(fixedNs!)).toBe(true);
  });

  it('parses ISO timestamp strings', () => {
    const d = normalizeInfluxTimestamp('2026-02-11T15:30:00Z');
    expect(d.toISOString()).toBe('2026-02-11T15:30:00.000Z');
  });
});
