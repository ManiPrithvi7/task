import {
  buildOtaDownloadUrl,
  buildOtaMqttDownloadUrl,
  isLocalLanDownloadUrl,
  isOciFirmwareDownloadUrl
} from '@/utils/otaDownloadUrl';

const otaConfig = {
  enabled: true,
  oci: {
    namespace: 'ns',
    bucket: 'proof-firmware-ota',
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

const proxyOtaConfig = { ...otaConfig, downloadMode: 'proxy' as const };

const release = {
  version: '4.3.1-mvp',
  objectKey: 'firmware/4.3.1-mvp/firmware.bin'
};

describe('otaDownloadUrl', () => {
  it('detects OCI PAR URLs', () => {
    expect(
      isOciFirmwareDownloadUrl(
        'https://ax4egmknthnr.objectstorage.ap-hyderabad-1.oci.customer-oci.com/p/abc/firmware.bin'
      )
    ).toBe(true);
  });

  it('detects LAN dev URLs', () => {
    expect(isLocalLanDownloadUrl('http://192.168.29.95:8765/firmware-4.3.1-mvp.bin')).toBe(true);
  });

  it('buildOtaMqttDownloadUrl always returns OCI presigned URL', async () => {
    const storage = {
      createPresignedGetUrl: jest
        .fn()
        .mockResolvedValue(
          'https://ns.objectstorage.ap-hyderabad-1.oci.customer-oci.com/p/read/firmware.bin'
        )
    };

    const url = await buildOtaMqttDownloadUrl(release, proxyOtaConfig, storage as never);

    expect(url).toContain('objectstorage');
    expect(storage.createPresignedGetUrl).toHaveBeenCalledWith(
      'firmware/4.3.1-mvp/firmware.bin',
      '4.3.1-mvp'
    );
  });

  it('buildOtaMqttDownloadUrl rejects non-OCI URL from storage', async () => {
    const storage = {
      createPresignedGetUrl: jest
        .fn()
        .mockResolvedValue('http://192.168.29.95:8765/firmware-target.bin')
    };

    await expect(
      buildOtaMqttDownloadUrl(release, otaConfig, storage as never)
    ).rejects.toThrow(/OCI presigned URL generation failed/);
  });

  it('buildOtaDownloadUrl uses OCI presigned URL in presigned mode', async () => {
    const storage = {
      createPresignedGetUrl: jest
        .fn()
        .mockResolvedValue(
          'https://ns.objectstorage.ap-hyderabad-1.oci.customer-oci.com/p/read/firmware.bin'
        )
    };

    const url = await buildOtaDownloadUrl(
      release,
      otaConfig,
      storage as never,
      'http://localhost:3002'
    );

    expect(url).toContain('objectstorage');
    expect(storage.createPresignedGetUrl).toHaveBeenCalledWith(
      'firmware/4.3.1-mvp/firmware.bin',
      '4.3.1-mvp'
    );
  });

  it('buildOtaDownloadUrl uses proxy URL in proxy mode', async () => {
    const storage = {
      createPresignedGetUrl: jest.fn()
    };

    const url = await buildOtaDownloadUrl(
      release,
      proxyOtaConfig,
      storage as never,
      'https://server.withproof.io'
    );

    expect(url).toBe('https://server.withproof.io/api/v1/ota/download/4.3.1-mvp');
    expect(storage.createPresignedGetUrl).not.toHaveBeenCalled();
  });
});
