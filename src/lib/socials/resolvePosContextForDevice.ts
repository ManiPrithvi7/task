import { Device } from '../../models/Device';
import { Social, Provider } from '../../models/Social';
import { getUserIntegrations } from '../../services/userIntegrationCache';
import { logger } from '../../utils/logger';

export type DevicePosContext = {
  userId: string;
  deviceId: string;
  platform: 'shopify' | 'square';
};

/**
 * Resolve POS platform for a display device.
 * Prefers 24h user integration cache; falls back to Mongo Social query.
 */
export async function resolvePosContextForDevice(deviceId: string): Promise<DevicePosContext | null> {
  try {
    const deviceDoc = await Device.findOne({ clientId: deviceId }).select({ userId: 1 }).lean();
    if (!deviceDoc?.userId) {
      logger.debug('[POS_DEVICE] No user linked to device', { deviceId });
      return null;
    }

    const userId = String(deviceDoc.userId);
    const integrations = await getUserIntegrations(userId);
    if (integrations?.pos?.platform) {
      return { userId, deviceId, platform: integrations.pos.platform };
    }

    const shopify = await Social.findOne({
      userId: deviceDoc.userId,
      provider: Provider.SHOPIFY
    })
      .select({ _id: 1 })
      .lean();

    if (shopify) {
      return { userId, deviceId, platform: 'shopify' };
    }

    const square = await Social.findOne({
      userId: deviceDoc.userId,
      provider: Provider.SQUARE
    })
      .select({ _id: 1 })
      .lean();

    if (square) {
      return { userId, deviceId, platform: 'square' };
    }

    logger.debug('[POS_DEVICE] No SHOPIFY or SQUARE social for user', { deviceId, userId });
    return null;
  } catch (err: unknown) {
    logger.warn('[POS_DEVICE] resolvePosContextForDevice failed', {
      deviceId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
