import type { RedisClientType } from 'redis';
import { parseStimTestOtaEnvSeed } from '../config/envHelpers';
import { REDIS_KEYS } from '../constants/redisKeys';
import { logger } from '../utils/logger';
import {
  generateStimLabKeypair,
  isProductionNodeEnv,
  type StimLabKeypair
} from '../utils/stimOtaCrypto';
import type { RedisService } from './redisService';

export const STIM_OTA_OBJECT_KEY = 'firmware/stim/firmware.bin';

export type StimOtaRedisOffer = {
  version: string;
  sha256: string;
  signature: string;
  sizeBytes: number;
  objectKey: string;
  downloadUrl: string;
  filename: string;
  updatedAt: string;
};

function redisClient(redis: RedisService | null): RedisClientType | null {
  if (!redis?.isRedisConnected()) return null;
  try {
    return redis.getClient();
  } catch {
    return null;
  }
}

export async function getOrCreateStimLabKeypair(redis: RedisService | null): Promise<StimLabKeypair> {
  if (isProductionNodeEnv()) {
    throw new Error('Stim lab Ed25519 keypair is not allowed when NODE_ENV=production');
  }
  const client = redisClient(redis);
  if (!client) {
    throw new Error('Redis is required to store stim lab Ed25519 keys');
  }

  const key = REDIS_KEYS.otaStimLabKeypair;
  const existing = await client.hGetAll(key);
  if (existing.private_pem?.includes('BEGIN') && existing.public_pem?.includes('BEGIN')) {
    return { privatePem: existing.private_pem, publicPem: existing.public_pem };
  }

  const locked = await client.set(REDIS_KEYS.otaStimLabKeypairLock, '1', { NX: true, EX: 30 });
  const retry = await client.hGetAll(key);
  if (retry.private_pem?.includes('BEGIN') && retry.public_pem?.includes('BEGIN')) {
    return { privatePem: retry.private_pem, publicPem: retry.public_pem };
  }

  if (!locked) {
    await new Promise((r) => setTimeout(r, 50));
    const after = await client.hGetAll(key);
    if (after.private_pem?.includes('BEGIN') && after.public_pem?.includes('BEGIN')) {
      return { privatePem: after.private_pem, publicPem: after.public_pem };
    }
    throw new Error('Stim lab keypair lock held but no PEM in Redis');
  }

  const pair = generateStimLabKeypair();
  await client.hSet(key, {
    private_pem: pair.privatePem,
    public_pem: pair.publicPem,
    created_at: new Date().toISOString()
  });
  logger.info('[STIM-OTA] Generated lab Ed25519 keypair in Redis');
  return pair;
}

export async function loadStimLabPublicPem(redis: RedisService | null): Promise<string | null> {
  try {
    const pair = await getOrCreateStimLabKeypair(redis);
    return pair.publicPem;
  } catch (err: unknown) {
    logger.warn('[STIM-OTA] Lab public key unavailable', {
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

export async function loadStimOtaOffer(redis: RedisService | null): Promise<StimOtaRedisOffer | null> {
  const client = redisClient(redis);
  if (!client) return null;
  const hash = await client.hGetAll(REDIS_KEYS.otaStimOffer);
  const version = hash.version?.trim();
  const sha256 = hash.sha256?.trim().toLowerCase();
  const signature = hash.signature?.trim();
  const objectKey = hash.object_key?.trim() || '';
  const downloadUrl = hash.download_url?.trim() || '';
  const sizeBytes = hash.size_bytes ? Number.parseInt(hash.size_bytes, 10) : NaN;
  if (!version || !sha256 || !signature || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return null;
  }
  if (!objectKey && !downloadUrl) {
    return null;
  }
  return {
    version,
    sha256,
    signature,
    sizeBytes,
    objectKey,
    downloadUrl,
    filename: hash.filename?.trim() || 'firmware.bin',
    updatedAt: hash.updated_at || ''
  };
}

export async function saveStimOtaOffer(
  redis: RedisService | null,
  offer: StimOtaRedisOffer
): Promise<void> {
  const client = redisClient(redis);
  if (!client) {
    throw new Error('Redis is required to store stim OTA offer');
  }
  await client.hSet(REDIS_KEYS.otaStimOffer, {
    version: offer.version,
    sha256: offer.sha256,
    signature: offer.signature,
    size_bytes: String(offer.sizeBytes),
    object_key: offer.objectKey,
    download_url: offer.downloadUrl,
    filename: offer.filename,
    updated_at: offer.updatedAt
  });
}

/** Copy TEST_OTA_VERSION/SHA256/SIGNATURE/SIZE_BYTES (+ optional URL) into Redis. MQTT reads Redis only. */
export async function seedStimOtaOfferFromEnv(redis: RedisService | null): Promise<boolean> {
  if (isProductionNodeEnv()) return false;
  const seed = parseStimTestOtaEnvSeed();
  if (!seed) return false;
  const existing = await loadStimOtaOffer(redis);
  const downloadUrl = seed.downloadUrl || existing?.downloadUrl || '';
  const objectKey = seed.downloadUrl ? '' : existing?.objectKey || '';
  if (!downloadUrl && !objectKey) {
    logger.warn('[STIM-OTA] Env metadata present but no TEST_OTA_URL or Redis object_key — skip seed');
    return false;
  }
  await saveStimOtaOffer(redis, {
    version: seed.version,
    sha256: seed.sha256,
    signature: seed.signature,
    sizeBytes: seed.sizeBytes,
    objectKey,
    downloadUrl,
    filename: existing?.filename || 'firmware.bin',
    updatedAt: new Date().toISOString()
  });
  logger.info('[STIM-OTA] Seeded Redis offer from TEST_OTA_* env', {
    version: seed.version,
    sizeBytes: seed.sizeBytes,
    hasDownloadUrl: Boolean(downloadUrl),
    hasObjectKey: Boolean(objectKey)
  });
  return true;
}

export async function hasStimRedisOffer(redis: RedisService | null): Promise<boolean> {
  return Boolean(await loadStimOtaOffer(redis));
}
