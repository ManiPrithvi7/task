import { SquareProfile } from '../../models/SquareProfile';
import { Social } from '../../models/Social';

export async function resolveSquareUserId(merchantId: string): Promise<string | null> {
  const profile = await SquareProfile.findOne({ merchantId }).lean();
  if (!profile?.socialId) return null;

  const social = await Social.findById(profile.socialId).lean();
  if (!social?.userId) return null;

  return String(social.userId);
}
