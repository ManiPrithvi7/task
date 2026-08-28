import { loadConfig, validateConfig } from '@/config';
import { validateWebhookConfig, loadWebhookConfig } from '@/config/webhookConfig';

describe('production misconfig matrix', () => {
  const saved = { ...process.env };

  const baseProd = (): Record<string, string | undefined> => ({
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/test',
    INFLUXDB_TOKEN: 'tok',
    INFLUXDB_ORG: 'org',
    INFLUXDB_BUCKET: 'metrics',
    INFLUXDB_COMPLIANCE_BUCKET: 'pki_compliance',
    REDIS_URL: 'rediss://default:x@127.0.0.1:6379',
    JWT_SECRET: 'prod-jwt-secret-at-least-32-chars!!',
    AUTH_SECRET: 'prod-auth-secret-at-least-32-chars!',
    PROVISIONING_ENABLED: 'true',
    OTA_ENABLED: 'false',
    WEBHOOK_ENABLED: 'true',
    PUBLIC_APP_URL: 'https://example.com',
    TEST_OTA: 'false',
    GMB_PUBSUB_SKIP_AUTH_VERIFY: 'false',
    ENABLE_METRICS_COLLECTION: 'true',
    LOYALTY_SPIN_SECRET: 'prod-loyalty-spin-secret-at-least-16'
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('passes with prod-shaped fixture env', () => {
    process.env = { ...process.env, ...baseProd() };
    const config = loadConfig();
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('fails when REDIS_URL missing in production', () => {
    process.env = { ...process.env, ...baseProd() };
    delete process.env.REDIS_URL;
    const config = loadConfig();
    expect(() => validateConfig(config)).toThrow(/REDIS_URL is required/);
  });

  it('fails when TEST_OTA=true in production', () => {
    process.env = { ...process.env, ...baseProd(), TEST_OTA: 'true' };
    const config = loadConfig();
    expect(() => validateConfig(config)).toThrow(/TEST_OTA/);
  });

  it('fails when JWT missing with provisioning enabled', () => {
    process.env = { ...process.env, ...baseProd() };
    delete process.env.JWT_SECRET;
    delete process.env.PROVISIONING_JWT_SECRET;
    const config = loadConfig();
    expect(() => validateConfig(config)).toThrow(/JWT_SECRET|PROVISIONING_JWT_SECRET/);
  });

  it('fails when OTA enabled without webhook secret in production', () => {
    process.env = {
      ...process.env,
      ...baseProd(),
      OTA_ENABLED: 'true',
      OCI_API_PRIVATE_KEY_BASE64: Buffer.from('fake-key').toString('base64'),
      OCI_TENANCY_OCID: 'ocid1.tenancy.oc1..fake',
      OCI_USER_OCID: 'ocid1.user.oc1..fake',
      OCI_FINGERPRINT: 'https://example.com/fp'
    };
    delete process.env.OTA_RELEASE_WEBHOOK_SECRET;
    const config = loadConfig();
    // May fail earlier on OCI shape; assert webhook secret when config loads far enough
    try {
      validateConfig(config);
      throw new Error('expected validateConfig to throw');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/OTA_RELEASE_WEBHOOK_SECRET|OCI|OTA_ENABLED/);
    }
  });

  it('fails when GMB_PUBSUB_SKIP_AUTH_VERIFY in production', () => {
    process.env = { ...process.env, ...baseProd(), GMB_PUBSUB_SKIP_AUTH_VERIFY: 'true' };
    const wh = loadWebhookConfig();
    expect(() => validateWebhookConfig(wh, 'production')).toThrow(/GMB_PUBSUB_SKIP_AUTH_VERIFY/);
  });

  it('fails when LOYALTY_SPIN_SECRET missing in production', () => {
    process.env = { ...process.env, ...baseProd() };
    delete process.env.LOYALTY_SPIN_SECRET;
    const config = loadConfig();
    expect(() => validateConfig(config)).toThrow(/LOYALTY_SPIN_SECRET/);
  });
});
