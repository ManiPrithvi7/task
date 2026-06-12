import { compareVersions, isVersionGreater } from '@/utils/semver';
import {
  FirmwareRolloutStrategy
} from '@/models/FirmwareRelease';
import { DeviceStatus } from '@/models/Device';

jest.mock('@/models/Device', () => ({
  Device: {
    findOne: jest.fn(),
    updateOne: jest.fn()
  },
  DeviceStatus: {
    PROVISIONED: 'PROVISIONED',
    ACTIVE: 'ACTIVE',
    OFFLINE: 'OFFLINE',
    RECOVERY: 'RECOVERY',
    ERROR: 'ERROR'
  },
  DeviceOtaState: {
    IDLE: 'idle',
    ROLLBACK_REPORTED: 'rollback_reported'
  }
}));

jest.mock('@/models/FirmwareRelease', () => ({
  FirmwareRelease: {
    find: jest.fn()
  },
  FirmwareReleaseStatus: { STABLE: 'stable' },
  FirmwareRolloutStrategy: {
    ALL: 'all',
    PERCENTAGE: 'percentage',
    ALLOWLIST: 'allowlist'
  }
}));

import { Device } from '@/models/Device';
import { FirmwareRelease } from '@/models/FirmwareRelease';
import { OtaService } from '@/services/otaService';

const mockStorage = {
  createPresignedGetUrl: jest.fn().mockResolvedValue('https://s3.example/firmware.bin')
};

const otaConfig = {
  enabled: true,
  s3: { bucket: 'test-bucket', region: 'us-east-1' },
  presignedUrlTtlSec: 900,
  signingConfirmed: false,
  checkOnRegistration: false,
  broadcastTopic: 'proof.mqtt/broadcast/cmd',
  downloadMode: 'presigned' as const,
  checkRateLimitSec: 300,
  rollbackFailureThreshold: 3
};

describe('semver', () => {
  it('compares dotted versions', () => {
    expect(isVersionGreater('4.3.1', '4.3.0')).toBe(true);
    expect(compareVersions('4.3.0', '4.3.0')).toBe(0);
    expect(isVersionGreater('4.2.9', '4.3.0')).toBe(false);
  });
});

describe('OtaService.resolveUpdate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when device is in RECOVERY', async () => {
    (Device.findOne as jest.Mock).mockResolvedValue({
      clientId: 'dev-1',
      status: DeviceStatus.RECOVERY,
      otaBlockedVersions: []
    });
    (FirmwareRelease.find as jest.Mock).mockReturnValue({
      sort: () => ({
        limit: () => Promise.resolve([])
      })
    });

    const svc = new OtaService(otaConfig, mockStorage as never, 'http://localhost:3002');
    const offer = await svc.resolveUpdate({ deviceId: 'dev-1', currentVersion: '4.3.0' });
    expect(offer).toBeNull();
  });

  it('skips blocked versions', async () => {
    (Device.findOne as jest.Mock).mockResolvedValue({
      clientId: 'dev-1',
      status: DeviceStatus.ACTIVE,
      otaBlockedVersions: ['4.3.1'],
      save: jest.fn()
    });
    (FirmwareRelease.find as jest.Mock).mockReturnValue({
      sort: () => ({
        limit: () =>
          Promise.resolve([
            {
              version: '4.3.1',
              sha256: 'a'.repeat(64),
              signature: 'sig',
              s3Key: 'firmware/4.3.1/firmware.bin',
              sizeBytes: 1000,
              rollout: { strategy: FirmwareRolloutStrategy.ALL }
            }
          ])
      })
    });

    const svc = new OtaService(otaConfig, mockStorage as never, 'http://localhost:3002');
    const offer = await svc.resolveUpdate({ deviceId: 'dev-1', currentVersion: '4.3.0' });
    expect(offer).toBeNull();
  });
});

describe('OtaService.recordRollbackFailure', () => {
  it('blocks version after threshold failures', async () => {
    const save = jest.fn();
    const failures = new Map<string, number>([['4.3.1', 2]]);
    (Device.findOne as jest.Mock).mockResolvedValue({
      clientId: 'dev-1',
      otaRollbackFailures: failures,
      otaBlockedVersions: [],
      save
    });

    const svc = new OtaService(otaConfig, mockStorage as never, 'http://localhost:3002');
    const result = await svc.recordRollbackFailure('dev-1', '4.3.1', 'health check failed');
    expect(result.blocked).toBe(true);
    expect(result.failures).toBe(3);
    expect(save).toHaveBeenCalled();
  });
});
