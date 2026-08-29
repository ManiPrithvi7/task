import mongoose from 'mongoose';
import { Device } from '../../models/Device';
import { Social, Provider } from '../../models/Social';
import { GoogleBusinessProfile } from '../../models/GoogleBusinessProfile';
import { GoogleBusinessLocation } from '../../models/GoogleBusinessLocation';
import { logger } from '../../utils/logger';

export type DeviceGmbContext = {
  businessId: string;
  deviceId: string;
  verifiedReviewCount: number;
  averageRating?: number;
  locationName?: string;
};

/**
 * Resolve GMB snapshot for a display device from Mongo (no live GBP API in v1).
 * deviceId === Device.clientId === MQTT topic segment.
 */
export async function resolveGmbContextForDevice(deviceId: string): Promise<DeviceGmbContext | null> {
  try {
    const deviceDoc = await Device.findOne({ clientId: deviceId }).select({ businessId: 1 }).lean();
    if (!deviceDoc?.businessId) {
      logger.debug('[GMB_DEVICE] No business linked to device', { deviceId });
      return null;
    }

    const businessId = String(deviceDoc.businessId);
    const social = await Social.findOne({
      businessId: deviceDoc.businessId,
      provider: Provider.GOOGLE_BUSINESS
    })
      .select({ _id: 1 })
      .lean();

    if (!social) {
      logger.debug('[GMB_DEVICE] No GOOGLE_BUSINESS social for business', { deviceId, businessId });
      return null;
    }

    const profiles = await GoogleBusinessProfile.find({ socialId: social._id }).select({ _id: 1 }).lean();
    const profileIds = profiles.map((p) => p._id);
    if (profileIds.length === 0) {
      logger.debug('[GMB_DEVICE] No GoogleBusinessProfile rows', { deviceId, businessId });
      return null;
    }

    const locationRecord = await GoogleBusinessLocation.findOne({
      profileId: { $in: profileIds }
    })
      .sort({ updatedAt: -1 })
      .lean();

    if (!locationRecord) {
      logger.debug('[GMB_DEVICE] No GoogleBusinessLocation for profiles', { deviceId, businessId });
      return null;
    }
    return {
      businessId,
      deviceId,
      verifiedReviewCount: locationRecord.totalReviewCount ?? 0,
      averageRating: locationRecord.averageRating,
      locationName: locationRecord.locationName
    };
  } catch (err: unknown) {
    logger.warn('[GMB_DEVICE] resolveGmbContextForDevice failed', {
      deviceId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
