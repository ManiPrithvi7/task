import { resolveMqttClientId } from '@/config/envHelpers';

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
