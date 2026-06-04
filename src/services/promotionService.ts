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
import { getRedisService } from './redisService';
import {
  getUserIntegrations,
  invalidateUserIntegrations,
  cacheUserIntegrations,
  applySocialDisconnected,
  type UserIntegrationCache
} from './userIntegrationCache';
import { isCampaignActive } from './campaignSchedule';
import { logger } from '../utils/logger';

const PROMO_ACTIVE_KEY_PREFIX = 'promo:active:';
const PROMO_ROTATION_KEY_PREFIX = 'promo:rotation:';

export type ConnectionValidateEvent =
  | 'social.connected'
  | 'social.disconnected'
  | 'campaign.updated'
  | 'campaign.deleted'
  | 'integrations.refresh';

export type PromotionScreenPayload = {
  platform: string;
  Offer: string;
  message: string;
  qrText: string;
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

function promoActiveKey(userId: string): string {
  return `${PROMO_ACTIVE_KEY_PREFIX}${userId}`;
}

function promoRotationKey(deviceId: string): string {
  return `${PROMO_ROTATION_KEY_PREFIX}${deviceId}`;
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

  const redis = getRedisService();
  const key = promoActiveKey(userId);

  if (redis?.isRedisConnected()) {
    try {
      const cached = await redis.getClient().get(key);
      if (cached) {
        const parsed = JSON.parse(cached) as CachedCampaignDto[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          const active = filterSchedulableCampaigns(parsed);
          if (active.length > 0) {
            return { campaigns: active as unknown as ICampaign[], integrations: ints };
          }
        }
      }
    } catch {
      /* fall through */
    }
  }

  const campaigns = await queryEligibleCampaigns(userId, ints);
  const dto = campaigns.map(toCachedDto);

  if (redis?.isRedisConnected() && dto.length > 0) {
    try {
      await redis.getClient().set(key, JSON.stringify(dto), { EX: getPromotionCacheTtlSec() });
    } catch {
      /* best-effort */
    }
  }

  return { campaigns, integrations: ints };
}

export async function getNextPromotionIndex(deviceId: string, total: number): Promise<number> {
  if (total <= 0) return 0;
  if (total === 1) return 0;

  const redis = getRedisService();
  const key = promoRotationKey(deviceId);
  const ttl = getPromotionCacheTtlSec();

  if (!redis?.isRedisConnected()) return 0;

  try {
    const currentRaw = await redis.getClient().get(key);
    const index = currentRaw !== null && currentRaw !== '' ? Number(currentRaw) : 0;
    const safeIndex = Number.isFinite(index) ? Math.max(0, Math.min(total - 1, Math.floor(index))) : 0;
    const next = (safeIndex + 1) % total;
    await redis.getClient().set(key, String(next), { EX: ttl });
    return safeIndex;
  } catch {
    return 0;
  }
}

export async function invalidatePromotionCache(userId: string): Promise<void> {
  const redis = getRedisService();
  if (!redis?.isRedisConnected()) return;

  try {
    await redis.getClient().del(promoActiveKey(userId));
  } catch (err: unknown) {
    logger.warn('[PROMO_CACHE] invalidate failed', {
      userId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

export async function resetRotationForUser(userId: string): Promise<void> {
  const redis = getRedisService();
  if (!redis?.isRedisConnected()) return;

  const devices = (await getActiveDeviceCache().getAllActive()).filter((d) => d.userId === userId);
  try {
    const client = redis.getClient();
    await Promise.all(devices.map((d) => client.del(promoRotationKey(d.deviceId))));
  } catch {
    /* best-effort */
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
      await resetRotationForUser(userId);
      if (fanout) {
        devicesNotified = await fanoutPromotionToUserDevices(userId, deps, { force: true });
      }
      break;

    case 'campaign.updated':
    case 'campaign.deleted':
      await invalidatePromotionCache(userId);
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
