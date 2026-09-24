import type { RedisService } from '@/services/redisService';
import type { IFirmwareStorage } from '@/services/firmwareStorageService';
import { REDIS_KEYS } from '@/constants/redisKeys';
import {
  getOrCreateStimLabKeypair,
  loadStimOtaOffer,
  replaceStimFirmware,
  seedStimOtaOfferFromEnv
} from '@/services/stimulateService';
import { verifySha256HexSignature } from '@/utils/stimOtaCrypto';

function memoryRedis(): { hashes: Record<string, Record<string, string>>; svc: RedisService } {
  const hashes: Record<string, Record<string, string>> = {};
  const strings: Record<string, string> = {};
  const client = {
    hGetAll: async (key: string) => ({ ...(hashes[key] || {}) }),
    hSet: async (key: string, obj: Record<string, string>) => {
      hashes[key] = { ...(hashes[key] || {}), ...obj };
      return 1;
    },
    set: async (key: string, value: string, opts?: { NX?: boolean }) => {
      if (opts?.NX && strings[key]) return null;
      strings[key] = value;
      return 'OK';
    }
  };
  const svc = {
    isRedisConnected: () => true,
    getClient: () => client
  } as unknown as RedisService;
  return { hashes, svc };
}

describe('stim lab Redis keypair', () => {
  const origEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = origEnv;
  });

  it('generates once and returns the same PEM on second call', async () => {
    process.env.NODE_ENV = 'development';
    const { hashes, svc } = memoryRedis();
    const a = await getOrCreateStimLabKeypair(svc);
    const b = await getOrCreateStimLabKeypair(svc);
    expect(a.publicPem).toBe(b.publicPem);
    expect(a.privatePem).toBe(b.privatePem);
    expect(hashes[REDIS_KEYS.otaStimLabKeypair].public_pem).toBe(a.publicPem);
  });

  it('refuses to generate in production', async () => {
    process.env.NODE_ENV = 'production';
    const { svc } = memoryRedis();
    await expect(getOrCreateStimLabKeypair(svc)).rejects.toThrow(/production/);
  });
});

describe('replaceStimFirmware', () => {
  it('deletes previous object, puts new bin, stores signed offer', async () => {
    process.env.NODE_ENV = 'development';
    const { hashes, svc } = memoryRedis();
    hashes[REDIS_KEYS.otaStimOffer] = {
      version: 'old',
      sha256: 'a'.repeat(64),
      signature: Buffer.alloc(64, 1).toString('base64'),
      size_bytes: '1',
      object_key: 'firmware/stim/old.bin',
      filename: 'old.bin',
      updated_at: 't'
    };
    const deleted: string[] = [];
    const put: Array<{ key: string; version: string }> = [];
    const storage = {
      deleteObject: jest.fn(async (key: string) => {
        deleted.push(key);
      }),
      putObject: jest.fn(async (key: string, _body: Buffer, meta: { version: string }) => {
        put.push({ key, version: meta.version });
      })
    } as unknown as IFirmwareStorage;

    const bytes = Buffer.from('new-firmware');
    const offer = await replaceStimFirmware({
      redis: svc,
      storage,
      version: '9.9.9',
      bytes,
      filename: 'ESP32.ino.bin'
    });

    expect(deleted.sort()).toEqual(['firmware/stim/firmware.bin', 'firmware/stim/old.bin'].sort());
    expect(put).toEqual([{ key: 'firmware/stim/firmware.bin', version: '9.9.9' }]);
    expect(offer.version).toBe('9.9.9');
    expect(offer.sizeBytes).toBe(bytes.length);
    const stored = await loadStimOtaOffer(svc);
    expect(stored?.sha256).toBe(offer.sha256);
    expect(stored?.downloadUrl).toBe('');
    const pair = await getOrCreateStimLabKeypair(svc);
    expect(verifySha256HexSignature(offer.sha256, offer.signature, pair.publicPem)).toBe(true);
  });
});

describe('seedStimOtaOfferFromEnv', () => {
  const origEnv = process.env;

  afterEach(() => {
    process.env = origEnv;
  });

  it('writes TEST_OTA_* metadata into Redis', async () => {
    process.env = { ...origEnv };
    process.env.NODE_ENV = 'development';
    process.env.TEST_OTA_URL = 'https://cdn.example.com/fw.bin';
    process.env.TEST_OTA_VERSION = 'v101';
    process.env.TEST_OTA_SHA256 = 'f'.repeat(64);
    process.env.TEST_OTA_SIGNATURE = Buffer.alloc(64, 2).toString('base64');
    process.env.TEST_OTA_SIZE_BYTES = '1124448';
    const { hashes, svc } = memoryRedis();
    await expect(seedStimOtaOfferFromEnv(svc)).resolves.toBe(true);
    expect(hashes[REDIS_KEYS.otaStimOffer].version).toBe('v101');
    expect(hashes[REDIS_KEYS.otaStimOffer].sha256).toBe('f'.repeat(64));
    expect(hashes[REDIS_KEYS.otaStimOffer].size_bytes).toBe('1124448');
    expect(hashes[REDIS_KEYS.otaStimOffer].download_url).toBe('https://cdn.example.com/fw.bin');
    expect(hashes[REDIS_KEYS.otaStimOffer].object_key).toBe('');
    const loaded = await loadStimOtaOffer(svc);
    expect(loaded?.version).toBe('v101');
    expect(loaded?.sizeBytes).toBe(1124448);
  });
});
