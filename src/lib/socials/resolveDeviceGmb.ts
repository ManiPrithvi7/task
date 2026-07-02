import mongoose from 'mongoose';
import { Device } from '../../models/Device';
import { Social, Provider } from '../../models/Social';
import { GoogleBusinessProfile } from '../../models/GoogleBusinessProfile';
import { GoogleBusinessLocation } from '../../models/GoogleBusinessLocation';
import { logger } from '../../utils/logger';

export type DeviceGmbContext = {
  userId: string;
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
    const deviceDoc = await Device.findOne({ clientId: deviceId }).select({ userId: 1 }).lean();
    if (!deviceDoc?.userId) {
      logger.debug('[GMB_DEVICE] No user linked to device', { deviceId });
      // #region agent log
      fetch('http://127.0.0.1:7244/ingest/b23bd0da-dae5-4d29-96a5-e5f39343cdd6',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'bf7e3f'},body:JSON.stringify({sessionId:'bf7e3f',hypothesisId:'H2',location:'resolveDeviceGmb.ts',message:'gmb resolve early exit',data:{deviceId,reason:'no_user'},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      return null;
    }

    const userId = String(deviceDoc.userId);
    const social = await Social.findOne({
      userId: deviceDoc.userId,
      provider: Provider.GOOGLE_BUSINESS
    })
      .select({ _id: 1 })
      .lean();

    if (!social) {
      logger.debug('[GMB_DEVICE] No GOOGLE_BUSINESS social for user', { deviceId, userId });
      // #region agent log
      fetch('http://127.0.0.1:7244/ingest/b23bd0da-dae5-4d29-96a5-e5f39343cdd6',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'bf7e3f'},body:JSON.stringify({sessionId:'bf7e3f',hypothesisId:'H2',location:'resolveDeviceGmb.ts',message:'gmb resolve early exit',data:{deviceId,userId,reason:'no_social'},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      return null;
    }

    const profiles = await GoogleBusinessProfile.find({ socialId: social._id }).select({ _id: 1 }).lean();
    const profileIds = profiles.map((p) => p._id);
    if (profileIds.length === 0) {
      logger.debug('[GMB_DEVICE] No GoogleBusinessProfile rows', { deviceId, userId });
      // #region agent log
      fetch('http://127.0.0.1:7244/ingest/b23bd0da-dae5-4d29-96a5-e5f39343cdd6',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'bf7e3f'},body:JSON.stringify({sessionId:'bf7e3f',hypothesisId:'H2',location:'resolveDeviceGmb.ts',message:'gmb resolve early exit',data:{deviceId,userId,reason:'no_profile',socialId:String(social._id)},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      return null;
    }

    const locationRecord = await GoogleBusinessLocation.findOne({
      profileId: { $in: profileIds }
    })
      .sort({ updatedAt: -1 })
      .lean();

    if (!locationRecord) {
      logger.debug('[GMB_DEVICE] No GoogleBusinessLocation for profiles', { deviceId, userId });
      // #region agent log
      fetch('http://127.0.0.1:7244/ingest/b23bd0da-dae5-4d29-96a5-e5f39343cdd6',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'bf7e3f'},body:JSON.stringify({sessionId:'bf7e3f',hypothesisId:'H2',location:'resolveDeviceGmb.ts',message:'gmb resolve early exit',data:{deviceId,userId,reason:'no_location',profileCount:profileIds.length},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      return null;
    }

    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/b23bd0da-dae5-4d29-96a5-e5f39343cdd6',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'bf7e3f'},body:JSON.stringify({sessionId:'bf7e3f',hypothesisId:'H2',location:'resolveDeviceGmb.ts',message:'gmb resolve success',data:{deviceId,userId,verifiedReviewCount:locationRecord.totalReviewCount??0,averageRating:locationRecord.averageRating??null},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    return {
      userId,
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
