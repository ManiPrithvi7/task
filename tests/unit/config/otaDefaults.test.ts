import {
  buildOtaProxyDownloadUrl,
  resolveOtaDownloadMode,
  resolveOtaPublicBaseUrl
} from '@/config/otaDefaults';

describe('otaDefaults', () => {
  it('defaults download mode to proxy', () => {
    expect(resolveOtaDownloadMode(undefined)).toBe('proxy');
    expect(resolveOtaDownloadMode('')).toBe('proxy');
  });

  it('allows presigned override', () => {
    expect(resolveOtaDownloadMode('presigned')).toBe('presigned');
  });

  it('resolves public base URL from PUBLIC_APP_URL', () => {
    expect(
      resolveOtaPublicBaseUrl({
        publicAppUrl: 'https://server.withproof.io/',
        httpHost: '0.0.0.0',
        httpPort: 3002
      })
    ).toBe('https://server.withproof.io');
  });

  it('prefers OTA_PUBLIC_BASE_URL over PUBLIC_APP_URL', () => {
    expect(
      resolveOtaPublicBaseUrl({
        otaPublicBaseUrl: 'https://ota.example.com',
        publicAppUrl: 'https://server.withproof.io'
      })
    ).toBe('https://ota.example.com');
  });

  it('builds proxy download URL on configured domain', () => {
    expect(buildOtaProxyDownloadUrl('https://server.withproof.io', '4.3.1-mvp')).toBe(
      'https://server.withproof.io/api/v1/ota/download/4.3.1-mvp'
    );
  });
});
