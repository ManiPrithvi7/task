import { logger } from '../utils/logger';
import { getRedisService } from './redisService';

const TOKEN_KEY = (deviceId: string) => `device:${deviceId}:instagram_token`;
const ACCOUNT_ID_KEY = (deviceId: string) => `device:${deviceId}:instagram_account_id`;

export interface InstagramDeviceAuth {
  deviceId: string;
  accessToken: string;
  instagramAccountId: string;
}

export class InstagramRedisStore {
  async getDeviceAuth(deviceId: string): Promise<InstagramDeviceAuth | null> {
    const redis = getRedisService();
    if (!redis || !redis.isRedisConnected()) return null;

    try {
      const client = redis.getClient();
      const [accessToken, instagramAccountId] = await client.mGet([
        TOKEN_KEY(deviceId),
        ACCOUNT_ID_KEY(deviceId)
      ]);
      if (!accessToken || !instagramAccountId) return null;
      return { deviceId, accessToken, instagramAccountId };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('Failed to read Instagram auth from Redis', { deviceId, error: msg });
      return null;
    }
  }

  async setDeviceAuth(deviceId: string, accessToken: string, instagramAccountId: string): Promise<void> {
    const redis = getRedisService();
    if (!redis || !redis.isRedisConnected()) return;

    const client = redis.getClient();
    await client.set(TOKEN_KEY(deviceId), accessToken);
    await client.set(ACCOUNT_ID_KEY(deviceId), instagramAccountId);
  }
}

