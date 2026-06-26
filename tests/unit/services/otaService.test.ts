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
import { OtaCommandPublisher, OtaService } from '@/services/otaService';

const mockStorage = {
  createPresignedGetUrl: jest.fn().mockResolvedValue('https://objectstorage.ap-hyderabad-1.oraclecloud.com/p/par/firmware.bin')
};

const otaConfig = {
  enabled: true,
  oci: {
    namespace: 'ns',
    bucket: 'firmware-bucket',
    region: 'ap-hyderabad-1',
    parBaseUrl: 'https://ns.objectstorage.ap-hyderabad-1.oci.customer-oci.com'
  },
  presignedUrlTtlSec: 900,
  signingConfirmed: false,
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
              objectKey: 'firmware/4.3.1/firmware.bin',
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

describe('OtaCommandPublisher', () => {
  const ociUrl =
    'https://ns.objectstorage.ap-hyderabad-1.oci.customer-oci.com/p/read/firmware.bin';
  const proxyUrl = 'https://server.withproof.io/api/v1/ota/download/4.3.1-mvp';

  const baseOffer = {
    version: '4.3.1-mvp',
    sha256: 'a'.repeat(64),
    signature: 'sig',
    sizeBytes: 1000,
    expiresAt: new Date().toISOString()
  };

  function makePublisher(downloadMode: 'presigned' | 'proxy' = 'proxy') {
    return new OtaCommandPublisher(
      { publish: jest.fn().mockResolvedValue(undefined) } as never,
      'proof.mqtt',
      'proof.mqtt/broadcast/cmd',
      undefined,
      { ...otaConfig, downloadMode }
    );
  }

  it('accepts OCI presigned download_url for MQTT publish', async () => {
    const publisher = makePublisher();
    await expect(
      publisher.publishUpdateToDevice('DEVICE-17', { ...baseOffer, downloadUrl: ociUrl }, false)
    ).resolves.toBeUndefined();
  });

  it('rejects proxy download_url for MQTT publish', async () => {
    const publisher = makePublisher('proxy');
    await expect(
      publisher.publishUpdateToDevice('DEVICE-17', { ...baseOffer, downloadUrl: proxyUrl }, false)
    ).rejects.toThrow(/Refusing to publish non-OCI download_url/);
  });

  it('rejects LAN download_url for MQTT publish', async () => {
    const publisher = makePublisher();
    await expect(
      publisher.publishUpdateToDevice(
        'DEVICE-17',
        { ...baseOffer, downloadUrl: 'http://192.168.29.95:8765/firmware.bin' },
        false
      )
    ).rejects.toThrow(/Refusing to publish LAN/);
  });
});
