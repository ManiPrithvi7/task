import { parsePilotBootPayload, parsePilotOtaFailPayload, normalizeOtaEventKey } from '@/utils/pilotOtaPayload';

describe('pilotOtaPayload', () => {
  it('parses device_registration boot payload', () => {
    const parsed = parsePilotBootPayload({
      type: 'device_registration',
      deviceId: 'proof-abc123',
      timestamp: '2026-02-11T15:30:00Z',
      metadata: {
        fw_version: '4.3.1-mvp',
        boot_type: 'power_on',
        ipAddress: '192.168.1.10'
      }
    });

    expect(parsed.isPilotRegistration).toBe(true);
    expect(parsed.fwVersion).toBe('4.3.1-mvp');
    expect(parsed.bootType).toBe('power_on');
    expect(parsed.ipAddress).toBe('192.168.1.10');
  });

  it('parses ota-fail nested metadata', () => {
    const parsed = parsePilotOtaFailPayload({
      type: 'ota-fail',
      deviceId: 'proof-abc123',
      timestamp: '2026-02-11T15:30:00Z',
      metadata: {
        fw_version: '4.3.1-mvp',
        reason: 'health_check_failed'
      }
    });

    expect(parsed.version).toBe('4.3.1-mvp');
    expect(parsed.reason).toBe('health_check_failed');
  });

  it('normalizes hyphenated event types', () => {
    expect(normalizeOtaEventKey({ type: 'ota-fail' })).toBe('ota_fail');
  });
});
