import { loadConfig, validateConfig } from '@/config';

const cleanEnv = (): void => {
  delete process.env.INFLUXDB_COMPLIANCE_BUCKET;
};

const baseEnv = (): Record<string, string | undefined> => ({
  MONGODB_URI: 'mongodb://localhost:27017/test',
  INFLUXDB_TOKEN: 'test-token',
  INFLUXDB_ORG: 'statsmqtt',
  INFLUXDB_BUCKET: 'metrics',
  INFLUXDB_URL: 'http://localhost:8086',
  ENABLE_METRICS_COLLECTION: undefined
});

describe('influx config validation', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('throws when INFLUXDB_TOKEN is missing', () => {
    process.env = { ...process.env, ...baseEnv() };
    cleanEnv();
    delete process.env.INFLUXDB_TOKEN;
    const config = loadConfig();
    expect(config.influxdb.token).toBe('');
    expect(() => validateConfig(config)).toThrow(/INFLUXDB_TOKEN is REQUIRED/);
  });

  it('throws when ENABLE_METRICS_COLLECTION=false', () => {
    process.env = { ...process.env, ...baseEnv(), ENABLE_METRICS_COLLECTION: 'false' };
    cleanEnv();
    const config = loadConfig();
    expect(() => validateConfig(config)).toThrow(/ENABLE_METRICS_COLLECTION=false is not allowed/);
  });

  it('enables influx write logging in development', () => {
    process.env = { ...process.env, ...baseEnv(), NODE_ENV: 'development' };
    cleanEnv();
    const config = loadConfig();
    expect(config.influxdb.logWrites).toBe(true);
  });

  it('disables influx write logging in production', () => {
    process.env = { ...process.env, ...baseEnv(), NODE_ENV: 'production' };
    cleanEnv();
    const config = loadConfig();
    expect(config.influxdb.logWrites).toBe(false);
  });

  it('loads client batch and audit field length from env', () => {
    process.env = {
      ...process.env,
      ...baseEnv(),
      INFLUXDB_CLIENT_BATCH_SIZE: '250',
      INFLUX_AUDIT_MAX_FIELD_LENGTH: '2048'
    };
    cleanEnv();
    const config = loadConfig();
    expect(config.influxdb.clientBatchSize).toBe(250);
    expect(config.influxdb.auditMaxFieldLength).toBe(2048);
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('loads default complianceBucket from env', () => {
    process.env = { ...process.env, ...baseEnv() };
    cleanEnv();
    const config = loadConfig();
    expect(config.influxdb.complianceBucket).toBe('pki_compliance');
  });

  it('defaults complianceBucket to pki_compliance when env is empty', () => {
    process.env = { ...process.env, ...baseEnv(), INFLUXDB_COMPLIANCE_BUCKET: '' };
    const config = loadConfig();
    expect(config.influxdb.complianceBucket).toBe('pki_compliance');
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('loads custom complianceBucket from env', () => {
    process.env = { ...process.env, ...baseEnv(), INFLUXDB_COMPLIANCE_BUCKET: 'custom_compliance' };
    const config = loadConfig();
    expect(config.influxdb.complianceBucket).toBe('custom_compliance');
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('throws when REDIS_URL missing in production', () => {
    process.env = {
      ...process.env,
      ...baseEnv(),
      NODE_ENV: 'production',
      OTA_ENABLED: 'false'
    };
    cleanEnv();
    delete process.env.REDIS_URL;
    delete process.env.TEST_OTA;
    const config = loadConfig();
    expect(config.redis.url).toBeUndefined();
    expect(() => validateConfig(config)).toThrow(/REDIS_URL is required in production/);
  });

  it('throws when JWT secret missing in production with provisioning enabled', () => {
    process.env = {
      ...process.env,
      ...baseEnv(),
      NODE_ENV: 'production',
      REDIS_URL: 'rediss://default:token@example.upstash.io:6379',
      AUTH_SECRET: 'test-auth-secret'
    };
    cleanEnv();
    delete process.env.JWT_SECRET;
    delete process.env.PROVISIONING_JWT_SECRET;
    delete process.env.TEST_OTA;
    const config = loadConfig();
    expect(config.provisioning.jwtSecret).toBe('');
    expect(() => validateConfig(config)).toThrow(/JWT_SECRET or PROVISIONING_JWT_SECRET is required/);
  });
});
