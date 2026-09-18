import { StimulateService } from '@/services/stimulateService';
import type { MqttClientManager } from '@/servers/mqttClient';
import type { RedisService } from '@/services/redisService';
import { REDIS_KEYS } from '@/constants/redisKeys';

const SHA256 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const SIGNATURE = Buffer.alloc(64, 7).toString('base64');

function memoryRedis(offer?: Record<string, string>): {
  hashes: Record<string, Record<string, string>>;
  svc: RedisService;
} {
  const hashes: Record<string, Record<string, string>> = {};
  if (offer) hashes[REDIS_KEYS.otaStimOffer] = offer;
  const client = {
    hGetAll: async (key: string) => ({ ...(hashes[key] || {}) }),
    hSet: async (key: string, obj: Record<string, string>) => {
      hashes[key] = { ...(hashes[key] || {}), ...obj };
      return 1;
    }
  };
  const svc = {
    isRedisConnected: () => true,
    getClient: () => client
  } as unknown as RedisService;
  return { hashes, svc };
}

function setStimEnv(): void {
  process.env.STIMULATE_DEVICE = 'DEVICE-19';
  process.env.STIMULATE_PLATFORMS = 'none';
  process.env.OTA_ENABLED = 'false';
  process.env.NODE_ENV = 'development';
}

function redisOffer(): Record<string, string> {
  return {
    version: '4.3.1-stim',
    sha256: SHA256,
    signature: SIGNATURE,
    size_bytes: '1124448',
    download_url: 'https://cdn.example.com/firmware.bin',
    object_key: '',
    filename: 'firmware.bin',
    updated_at: 't'
  };
}

describe('StimulateService stim OTA on /active', () => {
  const origEnv = process.env;
  let svc: StimulateService;
  let publish: jest.Mock;
  let redis: RedisService;

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.STIMULATE_DEVICE;
    delete process.env.STIMULATE_PLATFORMS;
    setStimEnv();
    publish = jest.fn().mockResolvedValue(undefined);
    redis = memoryRedis(redisOffer()).svc;
    svc = new StimulateService();
  });

  afterEach(async () => {
    await svc.stop();
    process.env = origEnv;
  });

  async function start(extra?: { redis?: RedisService; storage?: never }): Promise<void> {
    await svc.start(
      { publish } as unknown as MqttClientManager,
      extra?.redis ?? redis,
      'proof.mqtt',
      true
    );
  }

  it('publishes ota_update from Redis offer only', async () => {
    await start();
    await svc.resetOnDeviceConnect('DEVICE-19');

    expect(publish).toHaveBeenCalledTimes(1);
    const msg = publish.mock.calls[0][0];
    expect(msg.topic).toBe('proof.mqtt/DEVICE-19/cmd');
    expect(msg.qos).toBe(2);
    expect(msg.retain).toBe(false);
    const payload = JSON.parse(msg.payload) as Record<string, unknown>;
    expect(payload).toMatchObject({
      cmd: 'ota_update',
      version: '4.3.1-stim',
      download_url: 'https://cdn.example.com/firmware.bin',
      sha256: SHA256,
      signature: SIGNATURE,
      size_bytes: 1124448,
      force: true,
      rollout: { strategy: 'percentage', percentage: 100 }
    });
    expect(typeof payload.issued_at).toBe('string');
  });

  it('does not publish OTA for a device outside STIMULATE_DEVICE', async () => {
    await start();
    await svc.resetOnDeviceConnect('DEVICE-15');
    expect(publish).not.toHaveBeenCalled();
  });

  it('still publishes when OTA_ENABLED=false', async () => {
    process.env.OTA_ENABLED = 'false';
    await start();
    await svc.resetOnDeviceConnect('DEVICE-19');
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('does not publish when Redis has no offer', async () => {
    redis = memoryRedis().svc;
    await start();
    await svc.resetOnDeviceConnect('DEVICE-19');
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not publish when Redis is disconnected', async () => {
    await start({ redis: { isRedisConnected: () => false } as RedisService });
    await svc.resetOnDeviceConnect('DEVICE-19');
    expect(publish).not.toHaveBeenCalled();
  });

  it('ignores TEST_OTA_* env when Redis has no offer', async () => {
    process.env.TEST_OTA_URL = 'https://cdn.example.com/firmware.bin';
    process.env.TEST_OTA_VERSION = '4.3.1-stim';
    process.env.TEST_OTA_SHA256 = SHA256;
    process.env.TEST_OTA_SIGNATURE = SIGNATURE;
    process.env.TEST_OTA_SIZE_BYTES = '1124448';
    redis = memoryRedis().svc;
    await start();
    await svc.resetOnDeviceConnect('DEVICE-19');
    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes Redis offer with minted PAR instead of stored URL', async () => {
    const storage = {
      createPresignedGetUrl: jest.fn().mockResolvedValue('https://objectstorage.example/p/stim.bin')
    };
    const hashes: Record<string, Record<string, string>> = {
      [REDIS_KEYS.otaStimOffer]: {
        version: '9.9.9',
        sha256: SHA256,
        signature: SIGNATURE,
        size_bytes: '42',
        object_key: 'firmware/stim/firmware.bin',
        filename: 'fw.bin',
        updated_at: 't'
      }
    };
    const redisWithOffer = {
      isRedisConnected: () => true,
      getClient: () => ({
        hGetAll: async (key: string) => ({ ...(hashes[key] || {}) }),
        hSet: async (key: string, obj: Record<string, string>) => {
          hashes[key] = { ...(hashes[key] || {}), ...obj };
          return 1;
        }
      })
    };
    await svc.start(
      { publish } as unknown as MqttClientManager,
      redisWithOffer as never,
      'proof.mqtt',
      true,
      storage as never
    );
    await svc.resetOnDeviceConnect('DEVICE-19');
    expect(storage.createPresignedGetUrl).toHaveBeenCalledWith('firmware/stim/firmware.bin', '9.9.9');
    const payload = JSON.parse(publish.mock.calls[0][0].payload) as Record<string, unknown>;
    expect(payload.download_url).toBe('https://objectstorage.example/p/stim.bin');
    expect(payload.signature).toBe(SIGNATURE);
    expect(payload.version).toBe('9.9.9');
    expect(payload.size_bytes).toBe(42);
  });
});
