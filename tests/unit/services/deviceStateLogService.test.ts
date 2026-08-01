/**
 * DeviceStateLogService — P0 Test Suite
 *
 * P0: Chain continuity + deterministic preimage
 * P0: First-transition genesis vs resume from Influx
 */

const mockGetInfluxService = jest.fn();

jest.mock('@/services/influxService', () => ({
  getInfluxService: (...args: unknown[]) => mockGetInfluxService(...args),
}));

jest.mock('@/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import * as crypto from 'crypto';
import {
  createDeviceStateLogService,
  type DeviceStateTransitionInput,
} from '@/services/deviceStateLogService';

function buildExpectedPreimage(fields: Record<string, unknown>): string {
  const sortedKeys = Object.keys(fields).sort();
  return JSON.stringify(fields, sortedKeys);
}

function expectedSha256(preimage: string): string {
  return crypto.createHash('sha256').update(preimage, 'utf8').digest('hex');
}

describe('DeviceStateLogService', () => {
  let influxMock: {
    queryLatestDeviceStateEntries: jest.Mock;
    queryLatestDeviceStateEntry: jest.Mock;
    writeDeviceStateLog: jest.Mock;
    writeDeviceActive: jest.Mock;
  };

  const fixedTimestamp = new Date('2026-07-31T12:00:00.000Z');

  beforeEach(() => {
    jest.clearAllMocks();

    influxMock = {
      queryLatestDeviceStateEntries: jest.fn().mockResolvedValue(new Map()),
      queryLatestDeviceStateEntry: jest.fn().mockResolvedValue(null),
      writeDeviceStateLog: jest.fn().mockResolvedValue(undefined),
      writeDeviceActive: jest.fn().mockResolvedValue(undefined),
    };

    mockGetInfluxService.mockReturnValue(influxMock);
    createDeviceStateLogService();
  });

  function baseInput(
    overrides: Partial<DeviceStateTransitionInput> = {}
  ): DeviceStateTransitionInput {
    return {
      deviceId: 'dev-1',
      event: 'active',
      reason: 'mqtt_connect',
      timestamp: fixedTimestamp,
      ...overrides,
    };
  }

  /* ══════════════════════════════════════════════════════════════
   * P0: Genesis vs resume from Influx
   * ══════════════════════════════════════════════════════════════ */

  describe('first transition', () => {
    it('starts genesis chain when no prior Influx entry exists', async () => {
      const service = createDeviceStateLogService();
      await service.recordTransition(baseInput());

      expect(influxMock.queryLatestDeviceStateEntry).toHaveBeenCalledWith('dev-1');
      expect(influxMock.writeDeviceStateLog).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceId: 'dev-1',
          sequence: 1,
          previousHash: 'GENESIS',
        })
      );
    });

    it('resumes chain from Influx when prior entry exists', async () => {
      influxMock.queryLatestDeviceStateEntry.mockResolvedValue({
        sequence: 5,
        hash: 'prior-hash-abc',
      });

      const service = createDeviceStateLogService();
      await service.recordTransition(baseInput({ event: 'inactive' }));

      expect(influxMock.writeDeviceStateLog).toHaveBeenCalledWith(
        expect.objectContaining({
          sequence: 6,
          previousHash: 'prior-hash-abc',
        })
      );
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P0: Chain continuity + deterministic preimage
   * ══════════════════════════════════════════════════════════════ */

  describe('chain continuity', () => {
    it('links second transition previousHash to first hash with sequence 2', async () => {
      const service = createDeviceStateLogService();

      await service.recordTransition(
        baseInput({
          fwVersion: '1.0.0',
          fwTrack: 'stable',
          ipHash: 'iphash1',
          userIdAtTime: 'user-1',
        })
      );

      const firstWrite = influxMock.writeDeviceStateLog.mock.calls[0][0];
      expect(firstWrite.sequence).toBe(1);
      expect(firstWrite.previousHash).toBe('GENESIS');

      await service.recordTransition(
        baseInput({
          event: 'inactive',
          timestamp: new Date('2026-07-31T12:01:00.000Z'),
          reason: 'lwt',
        })
      );

      const secondWrite = influxMock.writeDeviceStateLog.mock.calls[1][0];
      expect(secondWrite.sequence).toBe(2);
      expect(secondWrite.previousHash).toBe(firstWrite.hash);
    });

    it('computes deterministic hash from sorted-key JSON preimage', async () => {
      const service = createDeviceStateLogService();
      const input = baseInput({
        fwVersion: '2.0.0',
        fwTrack: 'beta',
        ipHash: 'abc123',
        userIdAtTime: '507f1f77bcf86cd799439011',
      });

      await service.recordTransition(input);

      const writeArg = influxMock.writeDeviceStateLog.mock.calls[0][0];
      const expectedPreimage = buildExpectedPreimage({
        deviceId: 'dev-1',
        event: 'active',
        fwTrack: 'beta',
        fwVersion: '2.0.0',
        ipHash: 'abc123',
        previousHash: 'GENESIS',
        timestamp: fixedTimestamp.toISOString(),
        userIdAtTime: '507f1f77bcf86cd799439011',
      });

      expect(writeArg.hashPreimage).toBe(expectedPreimage);
      expect(writeArg.hash).toBe(expectedSha256(expectedPreimage));
    });

    it('defaults optional preimage fields to null not undefined', async () => {
      const service = createDeviceStateLogService();
      await service.recordTransition(baseInput());

      const writeArg = influxMock.writeDeviceStateLog.mock.calls[0][0];
      const parsed = JSON.parse(writeArg.hashPreimage) as Record<string, unknown>;

      expect(parsed.fwTrack).toBeNull();
      expect(parsed.fwVersion).toBeNull();
      expect(parsed.ipHash).toBeNull();
      expect(parsed.userIdAtTime).toBeNull();
    });

    it('writes companion device_active metrics row', async () => {
      const service = createDeviceStateLogService();
      const input = baseInput({ fwVersion: '1.2.3', reason: 'puback' });

      await service.recordTransition(input);

      expect(influxMock.writeDeviceActive).toHaveBeenCalledWith({
        deviceId: 'dev-1',
        status: 'active',
        fwVersion: '1.2.3',
        fwTrack: undefined,
        ipHash: undefined,
        reason: 'puback',
        userIdAtTime: undefined,
        timestamp: fixedTimestamp,
      });
    });
  });

  describe('no influx', () => {
    it('returns early without throwing when influx is unavailable', async () => {
      mockGetInfluxService.mockReturnValue(null);
      const service = createDeviceStateLogService();

      await expect(service.recordTransition(baseInput())).resolves.toBeUndefined();
      expect(influxMock.writeDeviceStateLog).not.toHaveBeenCalled();
    });
  });
});
