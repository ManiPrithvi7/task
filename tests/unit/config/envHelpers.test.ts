import { assertTestOtaAllowed, isTestOtaEnabled, resolveMqttClientId } from '@/config/envHelpers';

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
});
