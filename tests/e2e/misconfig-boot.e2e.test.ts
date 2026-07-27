/**
 * Misconfig boot coverage via validateConfig (same rules as scripts/validate-env.ts).
 * Full script path uses tests/fixtures/prod-env.env in CI.
 */
import { loadConfig, validateConfig } from '@/config';

describe('E2E misconfig boot', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('fails fast when TEST_OTA is enabled in production', () => {
    process.env = {
      ...process.env,
      NODE_ENV: 'production',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/x',
      INFLUXDB_TOKEN: 't',
      INFLUXDB_ORG: 'o',
      INFLUXDB_BUCKET: 'b',
      REDIS_URL: 'rediss://default:x@127.0.0.1:6379',
      JWT_SECRET: 'prod-jwt-secret-at-least-32-chars!!',
      AUTH_SECRET: 'prod-auth-secret-at-least-32-chars!',
      TEST_OTA: 'true',
      WEBHOOK_ENABLED: 'false',
      OTA_ENABLED: 'false'
    };
    const config = loadConfig();
    expect(() => validateConfig(config)).toThrow(/TEST_OTA/);
  });

  it('fails fast when Redis missing in production', () => {
    process.env = {
      ...process.env,
      NODE_ENV: 'production',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/x',
      INFLUXDB_TOKEN: 't',
      INFLUXDB_ORG: 'o',
      INFLUXDB_BUCKET: 'b',
      JWT_SECRET: 'prod-jwt-secret-at-least-32-chars!!',
      AUTH_SECRET: 'prod-auth-secret-at-least-32-chars!',
      TEST_OTA: 'false',
      WEBHOOK_ENABLED: 'false',
      OTA_ENABLED: 'false'
    };
    delete process.env.REDIS_URL;
    const config = loadConfig();
    expect(() => validateConfig(config)).toThrow(/REDIS_URL/);
  });
});
