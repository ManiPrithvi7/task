import { ShopifyProfile } from '../../models/ShopifyProfile';
import { Social, Provider } from '../../models/Social';

export async function resolveShopifyUserId(shopDomain: string): Promise<string | null> {
  const profile = await ShopifyProfile.findOne({ shopDomain }).lean();
  if (!profile?.socialId) return null;

  const social = await Social.findById(profile.socialId).lean();
  if (!social?.userId) return null;

  return String(social.userId);
}

export { Provider };
