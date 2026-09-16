import mongoose from 'mongoose';
import { Device, DeviceStatus } from '../../models/Device';
import type { WebhookDeviceTarget } from '../../config/webhookConfig';
import { logger } from '../../utils/logger';

export type ResolvedDeviceTarget = {
  /** Prisma/Mongo device document id (for transaction logs). */
  deviceObjectId: string;
  /** MQTT topic segment — Device.clientId */
  clientId: string;
};

/**
 * Resolve MQTT publish targets for a user.
 * Default `primary`: oldest device by createdAt (Statsnapp getPrimaryDevice parity).
 */
export async function resolveDevicesForUser(
  userId: string,
  target: WebhookDeviceTarget
): Promise<ResolvedDeviceTarget[]> {
  const userOid = new mongoose.Types.ObjectId(userId);

  if (target === 'all_active') {
    const devices = await Device.find({
      userId: userOid,
      status: DeviceStatus.ACTIVE
    })
      .select({ _id: 1, clientId: 1 })
      .lean();

    return devices
      .filter((d) => typeof d.clientId === 'string' && d.clientId.length > 0)
      .map((d) => ({
        deviceObjectId: String(d._id),
        clientId: d.clientId as string
      }));
  }

  const primary = await Device.findOne({ userId: userOid })
    .sort({ createdAt: 1 })
    .select({ _id: 1, clientId: 1 })
    .lean();

  if (!primary?.clientId) {
    logger.warn('[WEBHOOK] No primary device for user', { userId });
    return [];
  }

  return [
    {
      deviceObjectId: String(primary._id),
      clientId: primary.clientId
    }
  ];
}
