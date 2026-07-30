import mongoose from 'mongoose';
import {
  Campaign,
  CampaignStatus,
  DiscountType,
  ScheduleType,
  type ICampaign
} from '../models/Campaign';
import { Provider } from '../models/Social';
import { getClaimBaseUrl } from '../config/connectionsConfig';
import { getActiveDeviceCache } from './deviceService';
import {
  getUserIntegrations,
  invalidateUserIntegrations,
  cacheUserIntegrations,
  applySocialDisconnected,
  type UserIntegrationCache
} from './userIntegrationCache';
import { isCampaignActive } from './campaignSchedule';
import { invalidateCanvasCache } from './brandCanvasService';
import {
  getLocalPromoActiveCache,
  getLocalPromoRotationCache
} from './localCaches';
import { logger } from '../utils/logger';

export type ConnectionValidateEvent =
  | 'social.connected'
  | 'social.disconnected'
  | 'campaign.updated'
  | 'campaign.deleted'
  | 'canvas.updated'
  | 'integrations.refresh';

export type PromotionScreenPayload = {
  platform: string;
  Offer: string;
  message: string;
  qrText: string;
  creativeUrl?: string;
  templateData?: Record<string, unknown>;
};

export type CachedCampaignDto = {
  _id: string;
  name: string;
  offerCode: string;
  platform: string;
  discountType: string;
  discountValue: number;
  description?: string;
  redemptionUrl?: string;
  socialId?: string;
  status: string;
  scheduleType: string;
  scheduleConfig?: Record<string, unknown>;
  startsAt?: string;
  endsAt?: string;
};

export type PromotionFanoutDeps = {
  topicRoot: string;
  publishForDevice: (deviceId: string, topicRoot: string, opts?: { force?: boolean }) => Promise<void>;
};

export function getPromotionCacheTtlSec(): number {
  const n = Number(process.env.PROMOTION_CACHE_TTL_SEC);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3600;
}

export function buildCampaignPayload(campaign: ICampaign | CachedCampaignDto): PromotionScreenPayload {
  const discountType =
    'discountType' in campaign && campaign.discountType
      ? (campaign.discountType as DiscountType)
      : DiscountType.PERCENTAGE;
  const discountValue =
    'discountValue' in campaign && typeof campaign.discountValue === 'number'
      ? campaign.discountValue
      : 0;

  const Offer =
    discountType === DiscountType.FIXED_AMOUNT
      ? `$${discountValue}`
      : `${discountValue}%`;

  const message =
    ('description' in campaign && campaign.description?.trim()) ||
    ('name' in campaign && campaign.name) ||
    '';

  const offerCode = 'offerCode' in campaign ? campaign.offerCode : '';
  const qrText =
    ('redemptionUrl' in campaign && campaign.redemptionUrl?.trim()) ||
    `${getClaimBaseUrl()}/claim/${offerCode}`;

  const platformRaw =
    'platform' in campaign && campaign.platform ? String(campaign.platform) : '';

  return {
    platform: platformRaw ? platformRaw.toLowerCase() : '',
    Offer,
    message,
    qrText
  };
}

/** Re-apply schedule/date gates (cache hits must re-check time windows). */
export function filterSchedulableCampaigns<T extends ICampaign | CachedCampaignDto>(
  campaigns: T[],
  now: Date = new Date()
): T[] {
  return campaigns.filter((c) => isCampaignActive(asCampaignForSchedule(c), now));
}

function asCampaignForSchedule(c: ICampaign | CachedCampaignDto): ICampaign {
  if ('startsAt' in c && typeof c.startsAt === 'string') {
    const dto = c as CachedCampaignDto;
    return {
      ...dto,
      startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
      endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
      status: dto.status as CampaignStatus,
      scheduleType: dto.scheduleType as ScheduleType
    } as unknown as ICampaign;
  }
  return c as ICampaign;
}

function posProviderFromCache(integrations: UserIntegrationCache): Provider | null {
  if (!integrations.pos) return null;
  return integrations.pos.platform === 'shopify' ? Provider.SHOPIFY : Provider.SQUARE;
}

function campaignSocialIdFilter(posSocialId: string) {
  const oid = mongoose.Types.ObjectId.isValid(posSocialId)
    ? new mongoose.Types.ObjectId(posSocialId)
    : posSocialId;

  return {
    $or: [{ socialId: { $exists: false } }, { socialId: null }, { socialId: oid }]
  };
}

async function queryEligibleCampaigns(
  userId: string,
  integrations: UserIntegrationCache
): Promise<ICampaign[]> {
  const posProvider = posProviderFromCache(integrations);
  if (!posProvider || !integrations.pos) return [];

  const userOid = new mongoose.Types.ObjectId(userId);
  const campaigns = await Campaign.find({
    userId: userOid,
    status: CampaignStatus.ACTIVE,
    platform: posProvider,
    ...campaignSocialIdFilter(integrations.pos.socialId)
  })
    .sort({ createdAt: -1 })
    .limit(3)
    .lean();

  return filterSchedulableCampaigns(campaigns as unknown as ICampaign[]);
}

function toCachedDto(c: ICampaign): CachedCampaignDto {
  return {
    _id: String(c._id),
    name: c.name,
    offerCode: c.offerCode,
    platform: String(c.platform),
    discountType: c.discountType,
    discountValue: c.discountValue,
    description: c.description,
    redemptionUrl: c.redemptionUrl,
    socialId: c.socialId ? String(c.socialId) : undefined,
    status: c.status,
    scheduleType: c.scheduleType,
    scheduleConfig: c.scheduleConfig as Record<string, unknown> | undefined,
    startsAt: c.startsAt ? c.startsAt.toISOString() : undefined,
    endsAt: c.endsAt ? c.endsAt.toISOString() : undefined
  };
}

export async function getEligibleCampaignsForUser(
  userId: string,
  integrations?: UserIntegrationCache | null
): Promise<{ campaigns: ICampaign[]; integrations: UserIntegrationCache | null }> {
  const ints = integrations ?? (await getUserIntegrations(userId));
  if (!ints?.pos) {
    return { campaigns: [], integrations: ints };
  }

  const cache = getLocalPromoActiveCache<CachedCampaignDto[]>();
  const cached = cache.get(userId);
  if (cached && Array.isArray(cached) && cached.length > 0) {
    const active = filterSchedulableCampaigns(cached);
    if (active.length > 0) {
      return { campaigns: active as unknown as ICampaign[], integrations: ints };
    }
  }

  const campaigns = await queryEligibleCampaigns(userId, ints);
  const dto = campaigns.map(toCachedDto);

  if (dto.length > 0) {
    cache.set(userId, dto, getPromotionCacheTtlSec() * 1000);
  }

  return { campaigns, integrations: ints };
}

export async function getNextPromotionIndex(deviceId: string, total: number): Promise<number> {
  if (total <= 0) return 0;
  if (total === 1) return 0;

  const rotation = getLocalPromoRotationCache();
  const current = rotation.get(deviceId);
  const safeIndex = Number.isFinite(current)
    ? ((Math.floor(current) % total) + total) % total
    : 0;
  rotation.increment(deviceId);
  return safeIndex;
}

export async function invalidatePromotionCache(userId: string): Promise<void> {
  getLocalPromoActiveCache().del(userId);
}

export async function resetRotationForUser(userId: string): Promise<void> {
  const devices = (await getActiveDeviceCache().getAllActive()).filter((d) => d.userId === userId);
  const rotation = getLocalPromoRotationCache();
  for (const d of devices) {
    rotation.clear(d.deviceId);
  }
}

export async function fanoutPromotionToUserDevices(
  userId: string,
  deps: PromotionFanoutDeps,
  opts?: { force?: boolean }
): Promise<number> {
  const devices = (await getActiveDeviceCache().getAllActive()).filter((d) => d.userId === userId);
  const force = opts?.force ?? false;

  await Promise.allSettled(
    devices.map((d) => deps.publishForDevice(d.deviceId, deps.topicRoot, { force }))
  );

  return devices.length;
}

export async function invalidateAndFanout(
  userId: string,
  deps: PromotionFanoutDeps,
  opts?: { force?: boolean }
): Promise<{ invalidated: boolean; devicesNotified: number }> {
  await invalidatePromotionCache(userId);
  await resetRotationForUser(userId);

  const devicesNotified = await fanoutPromotionToUserDevices(userId, deps, opts);

  logger.info('[PROMO_FANOUT] Invalidated cache and notified devices', {
    userId,
    devicesNotified
  });

  return { invalidated: true, devicesNotified };
}

export type HandleConnectionValidateOpts = {
  fanout?: boolean;
  force?: boolean;
  provider?: Provider;
};

export async function handleConnectionValidateEvent(
  event: ConnectionValidateEvent,
  userId: string,
  deps: PromotionFanoutDeps,
  opts?: HandleConnectionValidateOpts
): Promise<{
  ok: boolean;
  event: ConnectionValidateEvent;
  userId: string;
  integrationsCached: boolean;
  devicesNotified: number;
}> {
  const fanout = opts?.fanout !== false;
  const force = opts?.force ?? fanout;
  let integrationsCached = false;
  let devicesNotified = 0;

  switch (event) {
    case 'social.connected':
      await invalidateUserIntegrations(userId);
      integrationsCached = (await cacheUserIntegrations(userId)) !== null;
      await invalidatePromotionCache(userId);
      await invalidateCanvasCache(userId);
      await resetRotationForUser(userId);
      if (fanout) {
        devicesNotified = await fanoutPromotionToUserDevices(userId, deps, { force: true });
      }
      break;

    case 'social.disconnected':
      if (opts?.provider) {
        integrationsCached = (await applySocialDisconnected(userId, opts.provider)) !== null;
      } else {
        await invalidateUserIntegrations(userId);
        integrationsCached = (await cacheUserIntegrations(userId)) !== null;
      }
      await invalidatePromotionCache(userId);
      await invalidateCanvasCache(userId);
      await resetRotationForUser(userId);
      if (fanout) {
        devicesNotified = await fanoutPromotionToUserDevices(userId, deps, { force: true });
      }
      break;

    case 'campaign.updated':
    case 'campaign.deleted':
    case 'canvas.updated':
      await invalidatePromotionCache(userId);
      await invalidateCanvasCache(userId);
      await resetRotationForUser(userId);
      if (fanout) {
        devicesNotified = await fanoutPromotionToUserDevices(userId, deps, { force });
      }
      break;

    case 'integrations.refresh':
      await invalidateUserIntegrations(userId);
      integrationsCached = (await cacheUserIntegrations(userId)) !== null;
      if (fanout) {
        await invalidatePromotionCache(userId);
        await invalidateCanvasCache(userId);
        devicesNotified = await fanoutPromotionToUserDevices(userId, deps, { force });
      }
      break;

    default:
      logger.warn('[CONNECTIONS_VALIDATE] Unknown event', { event, userId });
  }

  return {
    ok: true,
    event,
    userId,
    integrationsCached,
    devicesNotified
  };
}
