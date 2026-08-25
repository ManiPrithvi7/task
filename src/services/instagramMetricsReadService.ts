import mongoose from 'mongoose';
import { Social, Provider } from '../models/Social';
import { getInfluxService } from './influxService';
import { getIgAccountFetchCoordinator } from './igAccountFetchCoordinator';
import { fetchInstagramProfileMetrics } from '../lib/socials/instagramMetrics';
import { ensureFreshInstagramAccessToken } from '../lib/socials/instagramTokenRefresh';
import { cachedQuery, invalidateCache } from './influxQueryCache';
import { logger } from '../utils/logger';

export type MetricsCurrentResponse = {
  followerCount: number;
  lastSyncedAt: string;
  source: 'mongo' | 'influx' | 'live';
};

export type MetricsHistoryResponse = {
  series: Array<{ t: string; count: number }>;
  totalGrowth?: number;
  lastSyncAt?: string;
};

const STALE_MS = 60_000;

type InstagramSocialLean = {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  socialAccountId: string;
  accessToken: string;
  tokenExp: string;
  tokenCreatedAt?: Date;
  followerCount?: number;
  lastSyncedAt?: Date;
  needsReauth?: boolean;
};

async function resolveSocial(opts: {
  userId?: string;
  socialId?: string;
}): Promise<InstagramSocialLean | null> {
  if (opts.socialId && mongoose.Types.ObjectId.isValid(opts.socialId)) {
    return Social.findOne({
      _id: new mongoose.Types.ObjectId(opts.socialId),
      provider: Provider.INSTAGRAM
    }).lean<InstagramSocialLean>();
  }
  if (opts.userId && mongoose.Types.ObjectId.isValid(opts.userId)) {
    return Social.findOne({
      userId: new mongoose.Types.ObjectId(opts.userId),
      provider: Provider.INSTAGRAM
    })
      .sort({ updatedAt: -1 })
      .lean<InstagramSocialLean>();
  }
  return null;
}

async function latestInfluxCount(igId: string): Promise<{ count: number; at: string } | null> {
  const influx = getInfluxService();
  if (!influx) return null;
  const rows = await influx.queryLatestIgMetricByIgId(igId);
  if (rows.length === 0) return null;
  const row = rows[rows.length - 1];
  const countRaw = row.followers_count ?? row.followersCount;
  const count = typeof countRaw === 'number' ? countRaw : parseInt(String(countRaw ?? ''), 10);
  if (!Number.isFinite(count)) return null;
  const t = typeof row._time === 'string' ? row._time : new Date(String(row._time)).toISOString();
  return { count, at: t };
}

async function refreshAccountIfAllowed(social: InstagramSocialLean): Promise<MetricsCurrentResponse | null> {
  const igId = social.socialAccountId;
  const userId = String(social.userId);
  const coordinator = getIgAccountFetchCoordinator();
  const decision = coordinator.decideFetch(igId, 'attention');
  if (decision.action === 'cache_hit') {
    const syncedAt = new Date(decision.fetchedAtMs);
    await Social.updateOne(
      { _id: social._id },
      { $set: { followerCount: decision.followersCount, lastSyncedAt: syncedAt } }
    );
    return {
      followerCount: decision.followersCount,
      lastSyncedAt: syncedAt.toISOString(),
      source: 'live'
    };
  }
  if (decision.action !== 'fetch') return null;

  try {
    const token = await ensureFreshInstagramAccessToken({
      deviceId: '',
      accessToken: social.accessToken,
      userId,
      tokenExp: social.tokenExp,
      tokenCreatedAt: social.tokenCreatedAt ?? null
    });
    const profile = await fetchInstagramProfileMetrics(token);
    if (!profile) return null;

    const now = new Date();
    const count = profile.metrics.followers_count;
    coordinator.recordFetch(igId, 'attention', {
      followersCount: count,
      username: profile.metrics.username
    });
    await Social.updateOne(
      { _id: social._id },
      { $set: { followerCount: count, lastSyncedAt: now, needsReauth: false } }
    );
    invalidateCache(`ig:metrics:history:${igId}:`);
    return {
      followerCount: count,
      lastSyncedAt: now.toISOString(),
      source: 'live'
    };
  } catch (err: unknown) {
    logger.warn('[IG_METRICS_READ] On-demand refresh failed', {
      userId,
      igId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

export async function getInstagramMetricsCurrent(opts: {
  userId?: string;
  socialId?: string;
  allowRefresh?: boolean;
}): Promise<MetricsCurrentResponse | null> {
  const social = await resolveSocial(opts);
  if (!social) return null;

  const lastSynced = social.lastSyncedAt ? social.lastSyncedAt.getTime() : 0;
  const stale = !lastSynced || Date.now() - lastSynced > STALE_MS;

  if (
    opts.allowRefresh !== false &&
    stale &&
    social.accessToken &&
    !social.needsReauth
  ) {
    const refreshed = await refreshAccountIfAllowed(social);
    if (refreshed) return refreshed;
  }

  if (typeof social.followerCount === 'number' && social.lastSyncedAt) {
    return {
      followerCount: social.followerCount,
      lastSyncedAt: social.lastSyncedAt.toISOString(),
      source: 'mongo'
    };
  }

  const influxLatest = await latestInfluxCount(social.socialAccountId);
  if (influxLatest) {
    return {
      followerCount: influxLatest.count,
      lastSyncedAt: influxLatest.at,
      source: 'influx'
    };
  }

  return null;
}

export async function getInstagramMetricsHistory(opts: {
  userId?: string;
  socialId?: string;
  range: '30d' | '90d';
}): Promise<MetricsHistoryResponse | null> {
  const social = await resolveSocial(opts);
  if (!social) return null;

  const influx = getInfluxService();
  if (!influx) return null;

  const fluxRange = opts.range === '30d' ? '-30d' : '-90d';
  const cacheKey = `ig:metrics:history:${social.socialAccountId}:${opts.range}`;

  const rows = await cachedQuery(
    cacheKey,
    () => influx.queryIgMetricsByIgId(social.socialAccountId, fluxRange),
    { freshMs: 30_000, staleMs: 120_000 }
  );

  const series: Array<{ t: string; count: number }> = [];
  for (const row of rows) {
    const countRaw = row.followers_count ?? row.followersCount;
    const count = typeof countRaw === 'number' ? countRaw : parseInt(String(countRaw ?? ''), 10);
    if (!Number.isFinite(count)) continue;
    const t =
      typeof row._time === 'string'
        ? row._time
        : row._time instanceof Date
          ? row._time.toISOString()
          : new Date(String(row._time)).toISOString();
    series.push({ t, count });
  }

  let totalGrowth: number | undefined;
  if (series.length >= 2) {
    totalGrowth = series[series.length - 1].count - series[0].count;
  }

  const lastSyncAt =
    social.lastSyncedAt?.toISOString() ??
    (series.length > 0 ? series[series.length - 1].t : undefined);

  return { series, totalGrowth, lastSyncAt };
}
