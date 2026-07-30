import { compareVersions, isVersionGreater } from '@/utils/semver';
import {
  FirmwareRolloutStrategy
} from '@/models/FirmwareRelease';
import { DeviceStatus } from '@/models/Device';

jest.mock('@/models/Device', () => ({
  Device: {
    findOne: jest.fn(),
    find: jest.fn(),
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
    find: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn()
  },
  FirmwareReleaseStatus: {
    STABLE: 'stable',
    DRAFT: 'draft',
    DEPRECATED: 'deprecated',
    DEPRECATED_RETRYABLE: 'deprecated_retryable'
  },
  FirmwareRolloutStrategy: {
    ALL: 'all',
    PERCENTAGE: 'percentage',
    ALLOWLIST: 'allowlist'
  }
}));

jest.mock('@/notifications/slackOta', () => ({
  sendOtaSlackAlert: jest.fn().mockResolvedValue(false)
}));

jest.mock('@/services/deviceService', () => ({
  getActiveDeviceCache: jest.fn().mockReturnValue({
    getAllActive: jest.fn().mockResolvedValue([])
  })
}));

jest.mock('@/services/otaReleaseLog', () => ({
  getOtaReleaseLog: jest.fn().mockReturnValue(null)
}));

const mockLogEvent = jest.fn().mockResolvedValue(undefined);

jest.mock('@/services/auditService', () => ({
  AuditEventType: {
    OTA_RELEASE_VALIDATED: 'OTA_RELEASE_VALIDATED',
    OTA_RELEASE_PROMOTED: 'OTA_RELEASE_PROMOTED',
    OTA_PUSH_SENT: 'OTA_PUSH_SENT',
    OTA_CHECK_NO_UPDATE: 'OTA_CHECK_NO_UPDATE',
    OTA_CHECK_OFFERED: 'OTA_CHECK_OFFERED',
    OTA_COMMAND_ISSUED: 'OTA_COMMAND_ISSUED',
    OTA_COMMAND_DELIVERED: 'OTA_COMMAND_DELIVERED',
    OTA_DEVICE_STATE_CHANGED: 'OTA_DEVICE_STATE_CHANGED',
    OTA_DEVICE_BLOCKED: 'OTA_DEVICE_BLOCKED',
    OTA_SUCCESS: 'OTA_SUCCESS',
    OTA_ROLLBACK: 'OTA_ROLLBACK'
  },
  getAuditService: jest.fn().mockReturnValue({ logEvent: mockLogEvent })
}));

import { Device } from '@/models/Device';
import { FirmwareRelease } from '@/models/FirmwareRelease';
import { deviceHashBucket, OtaCommandPublisher, OtaService } from '@/services/otaService';

const mockStorage = {
  createPresignedGetUrl: jest.fn().mockResolvedValue('https://objectstorage.ap-hyderabad-1.oraclecloud.com/p/par/firmware.bin')
};

const TEST_SIGNING_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAR5TPk29aGcfmwOnUhgDi0cm14fPExUM2R5tMbXfw+jg=
-----END PUBLIC KEY-----`;

const TEST_KEY_FINGERPRINT = '5b138628120cf118';

const VALID_SIGNATURE = 'CmmD2ISF07vIwPXDczMVrEl+UkS3Hec4/CnBReSFkcph24fN7GiwxGbiFO9t+BK70tQtKLLIXHYu+XcIc2OKAg==';

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
  rollbackFailureThreshold: 3,
  signingPublicKeyPem: TEST_SIGNING_KEY_PEM,
  stageAbortMinSample: 20,
  stageAbortFailureRate: 0.01,
  stageMinHours: 24,
  mqttPushConcurrency: 100
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

describe('OtaService.ingestRelease', () => {
  const mockStorage = {
    headObject: jest.fn(),
    verifySha256: jest.fn(),
    buildObjectKey: jest.fn(),
    createPresignedPutUrl: jest.fn(),
    createPresignedGetUrl: jest.fn()
  };

  const mockRedisState = {
    setActiveRelease: jest.fn(),
    seedPendingFleet: jest.fn(),
    getActiveRelease: jest.fn().mockResolvedValue(null),
    clearStageAttempted: jest.fn(),
    markStageAttempted: jest.fn().mockResolvedValue(true),
    filterPending: jest.fn().mockImplementation((_v: string, ids: string[]) => Promise.resolve(ids))
  };

  const mockPublisher = {
    publishUpdateToDevice: jest.fn()
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('includes keyFingerprint in setActiveRelease and defaults to 1%', async () => {
    mockStorage.headObject.mockResolvedValue({ sizeBytes: 1000, firmwareVersion: '4.3.1', sha256: 'a'.repeat(64) });
    mockStorage.verifySha256.mockResolvedValue(true);
    (Device.find as jest.Mock).mockReturnValue({
      select: jest.fn().mockResolvedValue([])
    });
    const releaseDoc = {
      version: '4.3.1',
      sha256: 'a'.repeat(64),
      signature: VALID_SIGNATURE,
      objectKey: 'firmware/4.3.1/firmware.bin',
      s3Key: 'firmware/4.3.1/firmware.bin',
      sizeBytes: 1000,
      status: 'stable',
      currentPercentage: 1,
      aborted: false,
      rollout: { strategy: 'percentage', percentage: 1, deviceIds: [] },
      releasedAt: new Date()
    };
    (FirmwareRelease.findOne as jest.Mock).mockImplementation((query: Record<string, unknown>) => {
      if (query?.status === 'deprecated') return Promise.resolve(null);
      // previousVersion lookup needs a chain
      if (query?.status === 'stable' && query?.version && typeof query.version === 'object') {
        return {
          sort: () => ({
            select: () => ({
              lean: () => Promise.resolve(null)
            })
          })
        };
      }
      if (query?.version && query?.status === 'stable') return Promise.resolve(releaseDoc);
      return Promise.resolve(null);
    });
    (FirmwareRelease.findOneAndUpdate as jest.Mock).mockResolvedValue(releaseDoc);

    const svc = new OtaService(
      otaConfig,
      mockStorage as never,
      'http://localhost:3002',
      mockPublisher as never,
      mockRedisState as never
    );
    const result = await svc.ingestRelease({
      version: '4.3.1',
      objectKey: 'firmware/4.3.1/firmware.bin',
      sha256: 'a'.repeat(64),
      signature: VALID_SIGNATURE,
      broadcast: true
    });

    expect(result).toEqual({ ok: true, version: '4.3.1', created: true, currentPercentage: 1 });
    expect(mockRedisState.setActiveRelease).toHaveBeenCalledWith(
      expect.objectContaining({ keyFingerprint: TEST_KEY_FINGERPRINT }),
      1
    );
    expect(FirmwareRelease.findOneAndUpdate).toHaveBeenCalledWith(
      { version: '4.3.1' },
      expect.objectContaining({
        currentPercentage: 1,
        rollout: expect.objectContaining({ strategy: 'percentage', percentage: 1 })
      }),
      expect.any(Object)
    );
  });

  it('logs OTA_RELEASE_VALIDATED with result:false on FinalizeValidationError', async () => {
    mockStorage.headObject.mockResolvedValue({ sizeBytes: 1000, firmwareVersion: '4.3.1', sha256: 'b'.repeat(64) });

    const svc = new OtaService(
      otaConfig,
      mockStorage as never,
      'http://localhost:3002',
      mockPublisher as never
    );
    const result = await svc.ingestRelease({
      version: '4.3.1',
      objectKey: 'firmware/4.3.1/firmware.bin',
      sha256: 'a'.repeat(64),
      signature: VALID_SIGNATURE
    });

    expect(result).toEqual({ ok: false, httpStatus: 400, code: 'METADATA_SHA256_MISMATCH', error: expect.any(String) });
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'OTA_RELEASE_VALIDATED', details: expect.objectContaining({ result: false, code: 'METADATA_SHA256_MISMATCH', keyFingerprint: TEST_KEY_FINGERPRINT }) })
    );
  });
});

describe('OtaService.resolveUpdate buildOffer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns keyFingerprint in offer when signing key is configured', async () => {
    (Device.findOne as jest.Mock).mockResolvedValue({
      clientId: 'dev-1',
      status: DeviceStatus.ACTIVE,
      otaBlockedVersions: [],
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

    expect(offer).not.toBeNull();
    expect(offer!.keyFingerprint).toBe(TEST_KEY_FINGERPRINT);
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

  const previousTestOta = process.env.TEST_OTA;

  beforeEach(() => {
    delete process.env.TEST_OTA;
  });

  afterAll(() => {
    if (previousTestOta === undefined) {
      delete process.env.TEST_OTA;
    } else {
      process.env.TEST_OTA = previousTestOta;
    }
  });

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

  it('allows proxy download_url when TEST_OTA=true', async () => {
    process.env.TEST_OTA = 'true';
    const publisher = makePublisher('proxy');
    await expect(
      publisher.publishUpdateToDevice('DEVICE-17', { ...baseOffer, downloadUrl: proxyUrl }, false)
    ).resolves.toBeUndefined();
  });

  it('still rejects LAN download_url when TEST_OTA=true', async () => {
    process.env.TEST_OTA = 'true';
    const publisher = makePublisher();
    await expect(
      publisher.publishUpdateToDevice(
        'DEVICE-17',
        { ...baseOffer, downloadUrl: 'http://192.168.29.95:8765/firmware.bin' },
        false
      )
    ).rejects.toThrow(/Refusing to publish LAN/);
  });

  it('includes rollout in MQTT payload', async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const publisher = new OtaCommandPublisher(
      { publish } as never,
      'proof.mqtt',
      'proof.mqtt/broadcast/cmd',
      undefined,
      otaConfig
    );
    await publisher.publishUpdateToDevice(
      'DEVICE-17',
      {
        ...baseOffer,
        downloadUrl: ociUrl,
        rollout: { strategy: 'percentage', percentage: 10 }
      },
      false
    );
    const payload = JSON.parse(publish.mock.calls[0][0].payload);
    expect(payload.rollout).toEqual({ strategy: 'percentage', percentage: 10 });
  });
});

describe('OtaService.matchesRollout + failures', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('percentage strategy includes allowlisted devices outside bucket', () => {
    const svc = new OtaService(otaConfig, mockStorage as never, 'http://localhost:3002');
    const release = {
      version: '2.3.0',
      currentPercentage: 1,
      rollout: {
        strategy: FirmwareRolloutStrategy.PERCENTAGE,
        percentage: 1,
        deviceIds: ['DEVICE-13']
      }
    } as never;
    expect(svc.matchesRollout(release, { clientId: 'DEVICE-13' } as never, 'DEVICE-13')).toBe(true);
  });

  it('DEVICE-13 hash bucket is 40', () => {
    expect(deviceHashBucket('DEVICE-13')).toBe(40);
  });

  it('blacklists immediately on flash_error', async () => {
    const save = jest.fn();
    const device = {
      clientId: 'dev-1',
      otaRollbackFailures: new Map(),
      otaBlockedVersions: [],
      save
    };
    (Device.findOne as jest.Mock).mockResolvedValue(device);
    (FirmwareRelease.updateOne as jest.Mock).mockResolvedValue({});
    (FirmwareRelease.findOne as jest.Mock).mockResolvedValue({
      version: '2.3.0',
      aborted: false,
      stageAttemptedCount: 5,
      stageFailedCount: 1,
      stageRolledBackCount: 0
    });

    const svc = new OtaService(otaConfig, mockStorage as never, 'http://localhost:3002');
    const result = await svc.recordOtaFailure('dev-1', '2.3.0', 'flash_error');
    expect(result.blocked).toBe(true);
    expect(device.otaBlockedVersions).toContain('2.3.0');
  });

  it('does not blacklist on first download_timeout', async () => {
    const save = jest.fn();
    const device = {
      clientId: 'dev-1',
      otaRollbackFailures: new Map(),
      otaBlockedVersions: [],
      save
    };
    (Device.findOne as jest.Mock).mockResolvedValue(device);
    (FirmwareRelease.updateOne as jest.Mock).mockResolvedValue({});
    (FirmwareRelease.findOne as jest.Mock).mockResolvedValue({
      version: '2.3.0',
      aborted: false,
      stageAttemptedCount: 5,
      stageFailedCount: 0,
      stageRolledBackCount: 0
    });

    const svc = new OtaService(otaConfig, mockStorage as never, 'http://localhost:3002');
    const result = await svc.recordOtaFailure('dev-1', '2.3.0', 'download-timeout');
    expect(result.blocked).toBe(false);
    expect(result.failures).toBe(1);
  });

  it('skips counters for track_mismatch', async () => {
    const svc = new OtaService(otaConfig, mockStorage as never, 'http://localhost:3002');
    const result = await svc.recordOtaFailure('dev-1', '2.3.0', 'track_mismatch');
    expect(result).toEqual({ blocked: false, failures: 0 });
    expect(Device.findOne).not.toHaveBeenCalled();
  });

  it('advanceRollout returns 409 when aborted', async () => {
    (FirmwareRelease.findOne as jest.Mock).mockResolvedValue({
      version: '2.3.0',
      aborted: true,
      status: 'deprecated',
      currentPercentage: 10
    });
    const svc = new OtaService(otaConfig, mockStorage as never, 'http://localhost:3002');
    const result = await svc.advanceRollout('2.3.0');
    expect(result).toEqual(
      expect.objectContaining({ ok: false, httpStatus: 409, code: 'ROLLOUT_ABORTED' })
    );
  });
});
