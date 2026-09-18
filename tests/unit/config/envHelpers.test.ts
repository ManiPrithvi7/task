import {
  assertTestOtaAllowed,
  isTestOtaEnabled,
  parseStimTestOtaEnvSeed,
  resolveMqttClientId
} from '@/config/envHelpers';

describe('resolveMqttClientId', () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.MQTT_CLIENT_ID;
    delete process.env.MQTT_CLIENT_ID_STRICT;
    process.env.NODE_ENV = 'development';
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it('suffixes production client id in development', () => {
    process.env.MQTT_CLIENT_ID = 'proof-server';
    const id = resolveMqttClientId();
    expect(id).toMatch(/^proof-server-dev-\d+$/);
  });

  it('keeps custom client id in development', () => {
    process.env.MQTT_CLIENT_ID = 'my-local-publisher';
    expect(resolveMqttClientId()).toBe('my-local-publisher');
  });

  it('uses proof-server in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.MQTT_CLIENT_ID = 'proof-server';
    expect(resolveMqttClientId()).toBe('proof-server');
  });

  it('honors MQTT_CLIENT_ID_STRICT in development', () => {
    process.env.MQTT_CLIENT_ID = 'proof-server';
    process.env.MQTT_CLIENT_ID_STRICT = 'true';
    expect(resolveMqttClientId()).toBe('proof-server');
  });
});

describe('assertTestOtaAllowed', () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.TEST_OTA;
    delete process.env.TEST_OTA_URL;
    delete process.env.TEST_OTA_VERSION;
    delete process.env.TEST_OTA_SHA256;
    delete process.env.TEST_OTA_SIGNATURE;
    delete process.env.TEST_OTA_SIZE_BYTES;
    process.env.NODE_ENV = 'development';
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it('allows TEST_OTA in development', () => {
    process.env.TEST_OTA = 'true';
    expect(() => assertTestOtaAllowed()).not.toThrow();
    expect(isTestOtaEnabled()).toBe(true);
  });

  it('throws when TEST_OTA is set in production', () => {
    process.env.TEST_OTA = 'true';
    process.env.NODE_ENV = 'production';
    expect(() => assertTestOtaAllowed()).toThrow(/TEST_OTA=true is not allowed/);
  });

  it('throws when TEST_OTA_URL is set in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.TEST_OTA_URL = 'https://cdn.example.com/fw.bin';
    expect(() => assertTestOtaAllowed()).toThrow(/TEST_OTA_URL is not allowed/);
  });

  it('allows TEST_OTA_URL in development without offer metadata (Redis holds sha/sig)', () => {
    process.env.TEST_OTA_URL = 'https://cdn.example.com/fw.bin';
    expect(() => assertTestOtaAllowed()).not.toThrow();
  });
});

describe('parseStimTestOtaEnvSeed', () => {
  const origEnv = process.env;
  const sha256 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const signature = Buffer.alloc(64, 3).toString('base64');

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.TEST_OTA_URL;
    delete process.env.TEST_OTA_VERSION;
    delete process.env.TEST_OTA_SHA256;
    delete process.env.TEST_OTA_SIGNATURE;
    delete process.env.TEST_OTA_SIZE_BYTES;
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it('returns null when metadata is unset', () => {
    expect(parseStimTestOtaEnvSeed()).toBeNull();
  });

  it('parses metadata and optional URL for Redis seed', () => {
    process.env.TEST_OTA_URL = 'https://cdn.example.com/fw.bin';
    process.env.TEST_OTA_VERSION = 'stim:1';
    process.env.TEST_OTA_SHA256 = sha256;
    process.env.TEST_OTA_SIGNATURE = signature;
    process.env.TEST_OTA_SIZE_BYTES = '99';
    expect(parseStimTestOtaEnvSeed()).toEqual({
      downloadUrl: 'https://cdn.example.com/fw.bin',
      version: 'stim:1',
      sha256,
      signature,
      sizeBytes: 99
    });
  });

  it('rejects invalid sha256', () => {
    process.env.TEST_OTA_VERSION = 'stim:1';
    process.env.TEST_OTA_SHA256 = 'not-hex';
    process.env.TEST_OTA_SIGNATURE = signature;
    process.env.TEST_OTA_SIZE_BYTES = '99';
    expect(() => parseStimTestOtaEnvSeed()).toThrow(/TEST_OTA_SHA256/);
  });
});
