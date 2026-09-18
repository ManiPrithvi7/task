import type { IFirmwareStorage } from './firmwareStorageService';
import type { RedisService } from './redisService';
import {
  STIM_OTA_OBJECT_KEY,
  getOrCreateStimLabKeypair,
  loadStimOtaOffer,
  saveStimOtaOffer,
  type StimOtaRedisOffer
} from './stimOtaRedis';
import { isProductionNodeEnv, signAndVerifyFirmwareBytes } from '../utils/stimOtaCrypto';
import { logger } from '../utils/logger';

const STIM_OTA_MAX_BYTES = 2 * 1024 * 1024;

export async function replaceStimFirmware(input: {
  redis: RedisService | null;
  storage: IFirmwareStorage;
  version: string;
  bytes: Buffer;
  filename: string;
}): Promise<StimOtaRedisOffer> {
  if (isProductionNodeEnv()) {
    throw new Error('Stim firmware upload is not allowed when NODE_ENV=production');
  }
  const version = input.version.trim();
  if (!version) {
    throw new Error('version is required');
  }
  if (!input.bytes.length) {
    throw new Error('firmware file is empty');
  }
  if (input.bytes.length > STIM_OTA_MAX_BYTES) {
    throw new Error(`Firmware size ${input.bytes.length} exceeds maximum ${STIM_OTA_MAX_BYTES}`);
  }

  const previous = await loadStimOtaOffer(input.redis);
  const objectKey = STIM_OTA_OBJECT_KEY;
  const toDelete = new Set<string>([objectKey]);
  if (previous?.objectKey) toDelete.add(previous.objectKey);
  for (const key of toDelete) {
    await input.storage.deleteObject(key);
  }

  const keypair = await getOrCreateStimLabKeypair(input.redis);
  const { sha256, signature } = signAndVerifyFirmwareBytes(input.bytes, keypair);
  await input.storage.putObject(objectKey, input.bytes, { version, sha256 });

  const offer: StimOtaRedisOffer = {
    version,
    sha256,
    signature,
    sizeBytes: input.bytes.length,
    objectKey,
    downloadUrl: previous?.downloadUrl || '',
    filename: input.filename.trim() || 'firmware.bin',
    updatedAt: new Date().toISOString()
  };
  await saveStimOtaOffer(input.redis, offer);
  logger.info('[STIM-OTA] Stim firmware replaced', {
    version,
    sha256,
    sizeBytes: offer.sizeBytes,
    objectKey
  });
  return offer;
}
