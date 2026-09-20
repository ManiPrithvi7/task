import mongoose from 'mongoose';
import { Social, Provider } from '../../models/Social';
import { logger } from '../../utils/logger';

export type OwnedSocial = {
  _id: mongoose.Types.ObjectId;
  businessId?: mongoose.Types.ObjectId;
  userId?: mongoose.Types.ObjectId;
  socialAccountId: string;
  provider: Provider;
  accessToken: string;
  refreshToken: string;
  tokenExp: string;
  tokenCreatedAt?: Date;
  updatedAt?: Date;
};

export type FindOwnedSocialResult =
  | { status: 'ok'; social: OwnedSocial }
  | { status: 'not_found' };

function asOwnedSocial(doc: unknown): OwnedSocial {
  return doc as OwnedSocial;
}

function ownerIds(social: { businessId?: unknown; userId?: unknown }): string[] {
  return [social.businessId, social.userId]
    .filter((v) => v !== undefined && v !== null && String(v) !== '')
    .map((v) => String(v));
}

function isOwnedByBusiness(social: { businessId?: unknown; userId?: unknown }, businessId: string): boolean {
  return ownerIds(social).includes(businessId);
}

function providerValues(provider: Provider): string[] {
  if (provider === Provider.INSTAGRAM) return ['INSTAGRAM', 'instagram', 'ig', 'IG'];
  return ['GOOGLE_BUSINESS', 'google_business', 'GOOGLE-BUSINESS', 'gmb', 'GMB'];
}

/**
 * JWT `userId`/`sub` is the Business id (dashboard is business-scoped).
 * Mongo Social rows may store that same ObjectId on `businessId` or legacy `userId`.
 */
export function businessOwnerMatch(businessId: string): { $or: Array<Record<string, unknown>> } {
  const clause: Array<Record<string, unknown>> = [{ businessId }, { userId: businessId }];
  if (mongoose.Types.ObjectId.isValid(businessId)) {
    const oid = new mongoose.Types.ObjectId(businessId);
    clause.push({ businessId: oid }, { userId: oid });
  }
  return { $or: clause };
}

/**
 * Load Social for connect. Owner is the JWT principal (business id),
 * matched against `businessId` or legacy `userId`.
 */
export async function findOwnedSocial(opts: {
  businessId: string;
  socialAccountId: string;
  provider: Provider;
}): Promise<FindOwnedSocialResult> {
  const accountId = opts.socialAccountId.trim();
  const providers = providerValues(opts.provider);
  const owner = businessOwnerMatch(opts.businessId);

  const byAccount =
    (await Social.findOne({
      socialAccountId: accountId,
      provider: { $in: providers }
    }).lean()) ||
    (await Social.findOne({ socialAccountId: accountId }).lean());

  if (byAccount) {
    if (isOwnedByBusiness(byAccount, opts.businessId)) {
      return { status: 'ok', social: asOwnedSocial(byAccount) };
    }
    logger.warn('[INTEGRATIONS_CONNECT] Social not found', {
      businessId: opts.businessId,
      socialAccountId: accountId,
      provider: opts.provider
    });
    return { status: 'not_found' };
  }

  const indexed =
    (await Social.findOne({
      socialAccountId: accountId,
      provider: { $in: providers },
      ...owner
    }).lean()) ||
    (await Social.findOne({
      socialAccountId: accountId,
      ...owner
    }).lean());
  let social: OwnedSocial | null = indexed ? asOwnedSocial(indexed) : null;

  if (!social) {
    const raw = await Social.collection.findOne({
      socialAccountId: accountId,
      ...owner
    });
    if (raw && isOwnedByBusiness(raw as { businessId?: unknown; userId?: unknown }, opts.businessId)) {
      social = asOwnedSocial(raw);
    }
  }

  if (!social) {
    const latest = await Social.findOne({
      provider: { $in: providers },
      ...owner
    })
      .sort({ updatedAt: -1 })
      .lean();
    social = latest ? asOwnedSocial(latest) : null;
  }

  if (!social) {
    logger.warn('[INTEGRATIONS_CONNECT] Social not found', {
      businessId: opts.businessId,
      socialAccountId: accountId,
      provider: opts.provider
    });
    return { status: 'not_found' };
  }

  return { status: 'ok', social };
}

/** Prefer `businessId`; Prisma legacy docs may only have `userId` (same id). */
export function socialOwnerId(social: { businessId?: unknown; userId?: unknown }, fallback: string): string {
  return ownerIds(social)[0] || fallback;
}
