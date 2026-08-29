import { Social, Provider } from '../../models/Social';
import {
  getGmbAccountLookupValues,
  resolveGmbLocationResourceName
} from '../types/gmbReviewNotification';
import { GoogleBusinessLocation } from '../../models/GoogleBusinessLocation';
import { GoogleBusinessProfile } from '../../models/GoogleBusinessProfile';

export type GmbSocialContext = {
  businessId: string;
  socialId: string;
  locationObjectId: string;
  verifiedReviewCount: number;
  averageRating?: number;
  locationName?: string;
};

export async function resolveGmbSocialContext(
  account: string,
  location: string
): Promise<GmbSocialContext | null> {
  const accountLookup = getGmbAccountLookupValues(account);
  const social = await Social.findOne({
    socialAccountId: { $in: accountLookup },
    provider: Provider.GOOGLE_BUSINESS
  }).lean();

  if (!social?.businessId) return null;

  const profiles = await GoogleBusinessProfile.find({ socialId: social._id }).select({ _id: 1 }).lean();
  const profileIds = profiles.map((p) => p._id);
  if (profileIds.length === 0) return null;

  const locationResourceName = resolveGmbLocationResourceName(account, location);
  const locationSuffix = location.replace(/^\//, '');

  const locationRecord = await GoogleBusinessLocation.findOne({
    profileId: { $in: profileIds },
    $or: [
      { locationId: locationResourceName },
      { locationId: location },
      { locationId: { $regex: `${locationSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` } }
    ]
  }).lean();

  if (!locationRecord) return null;

  return {
    businessId: String(social.businessId),
    socialId: String(social._id),
    locationObjectId: String(locationRecord._id),
    verifiedReviewCount: locationRecord.totalReviewCount ?? 0,
    averageRating: locationRecord.averageRating,
    locationName: locationRecord.locationName
  };
}
