import { loadConfig, validateConfig } from '@/config';

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
    delete process.env.INFLUXDB_TOKEN;
    const config = loadConfig();
    expect(config.influxdb.token).toBe('');
    expect(() => validateConfig(config)).toThrow(/INFLUXDB_TOKEN is REQUIRED/);
  });

  it('throws when ENABLE_METRICS_COLLECTION=false', () => {
    process.env = { ...process.env, ...baseEnv(), ENABLE_METRICS_COLLECTION: 'false' };
    const config = loadConfig();
    expect(() => validateConfig(config)).toThrow(/ENABLE_METRICS_COLLECTION=false is not allowed/);
  });

  it('loads client batch and audit field length from env', () => {
    process.env = {
      ...process.env,
      ...baseEnv(),
      INFLUXDB_CLIENT_BATCH_SIZE: '250',
      INFLUX_AUDIT_MAX_FIELD_LENGTH: '2048'
    };
    const config = loadConfig();
    expect(config.influxdb.clientBatchSize).toBe(250);
    expect(config.influxdb.auditMaxFieldLength).toBe(2048);
    expect(() => validateConfig(config)).not.toThrow();
  });
});
