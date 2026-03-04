/**
 * Instagram Graph API Client
 *
 * Fetches follower counts, impressions, reach, and profile views
 * for a linked Instagram Business / Creator account.
 *
 * Rate-limited via InstagramRateLimiter (Redis-backed).
 * Retries on transient failures with exponential back-off.
 */

import https from 'https';
import { logger } from '../utils/logger';
import { getInstagramRateLimiter } from './instagramRateLimiter';

const GRAPH_BASE = 'graph.facebook.com';
const API_VERSION = 'v22.0';

export interface InstagramAccountInfo {
    accessToken: string;
    instagramAccountId: string;  // Instagram Business/Creator Account ID
    userId: string;              // Internal user ID (for logging / InfluxDB tags)
}

export interface InstagramMetrics {
    followers_count: number;
    followers_delta_24h: number;
    impressions_day: number;
    impressions_week: number;
    reach_day: number;
    reach_week: number;
    profile_views: number;
    media_count: number;
    engagement_rate: number;
}

export interface InstagramFetchResult {
    success: boolean;
    metrics?: InstagramMetrics;
    error?: string;
    errorCode?: string | number;
    apiResponseTimeMs: number;
    instagramAccountId: string;
    cacheHit: boolean;
}

/** Simple HTTP GET that resolves to the parsed JSON body. */
function httpsGet(url: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    if (parsed.error) {
                        const err = Object.assign(
                            new Error(parsed.error.message || 'Instagram API error'),
                            { code: parsed.error.code, type: parsed.error.type }
                        );
                        reject(err);
                    } else {
                        resolve(parsed);
                    }
                } catch (e) {
                    reject(new Error(`Failed to parse Instagram API response: ${body.slice(0, 200)}`));
                }
            });
        }).on('error', reject);
    });
}

/** Fetch basic account fields (followers, media_count) */
async function fetchAccountFields(accountId: string, accessToken: string): Promise<{ followers_count: number; media_count: number }> {
    const url = `https://${GRAPH_BASE}/${API_VERSION}/${accountId}?fields=followers_count,media_count&access_token=${accessToken}`;
    const data = await httpsGet(url) as { followers_count?: number; media_count?: number };
    return {
        followers_count: typeof data.followers_count === 'number' ? data.followers_count : 0,
        media_count: typeof data.media_count === 'number' ? data.media_count : 0
    };
}

/** Fetch insights metrics (impressions, reach, profile_views) for a given period */
async function fetchInsights(
    accountId: string,
    accessToken: string,
    period: 'day' | 'week'
): Promise<{ impressions: number; reach: number; profile_views: number }> {
    const metrics = period === 'day'
        ? 'impressions,reach,profile_views'
        : 'impressions,reach';
    const url = `https://${GRAPH_BASE}/${API_VERSION}/${accountId}/insights?metric=${metrics}&period=${period}&access_token=${accessToken}`;

    const data = await httpsGet(url) as { data?: Array<{ name: string; values: Array<{ value: number }> }> };
    const result = { impressions: 0, reach: 0, profile_views: 0 };

    if (Array.isArray(data.data)) {
        for (const metric of data.data) {
            const latestValue = metric.values?.[metric.values.length - 1]?.value ?? 0;
            if (metric.name === 'impressions') result.impressions = latestValue;
            if (metric.name === 'reach') result.reach = latestValue;
            if (metric.name === 'profile_views') result.profile_views = latestValue;
        }
    }

    return result;
}

/** Exponential back-off sleep */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fetch all Instagram metrics for a device with rate limiting and retry.
 */
export async function fetchInstagramMetrics(
    deviceId: string,
    account: InstagramAccountInfo,
    retryCount = 0
): Promise<InstagramFetchResult> {
    const rateLimiter = getInstagramRateLimiter();
    const startTime = Date.now();

    try {
        await rateLimiter.check(deviceId);

        logger.info('📸 [INSTAGRAM] Fetching metrics', {
            deviceId,
            accountId: account.instagramAccountId,
            attempt: retryCount + 1
        });

        // Parallel: account fields + day insights + week insights
        const [fields, dayInsights, weekInsights] = await Promise.all([
            fetchAccountFields(account.instagramAccountId, account.accessToken),
            fetchInsights(account.instagramAccountId, account.accessToken, 'day'),
            fetchInsights(account.instagramAccountId, account.accessToken, 'week')
        ]);

        const apiResponseTimeMs = Date.now() - startTime;

        const metrics: InstagramMetrics = {
            followers_count: fields.followers_count,
            followers_delta_24h: 0,       // Would need prev value from InfluxDB; defaulting to 0
            impressions_day: dayInsights.impressions,
            impressions_week: weekInsights.impressions,
            reach_day: dayInsights.reach,
            reach_week: weekInsights.reach,
            profile_views: dayInsights.profile_views,
            media_count: fields.media_count,
            engagement_rate: fields.followers_count > 0
                ? parseFloat(((dayInsights.impressions / fields.followers_count) * 100).toFixed(2))
                : 0
        };

        logger.info('✅ [INSTAGRAM] Metrics fetched successfully', {
            deviceId,
            followers: metrics.followers_count,
            impressions_day: metrics.impressions_day,
            apiResponseTimeMs
        });

        return {
            success: true,
            metrics,
            apiResponseTimeMs,
            instagramAccountId: account.instagramAccountId,
            cacheHit: false
        };

    } catch (error: unknown) {
        const apiResponseTimeMs = Date.now() - startTime;
        const err = error as Error & { code?: string | number };
        const errorCode = err.code;
        const errorMsg = err.message || 'Unknown error';

        // Rate limit error from Instagram API — retry with back-off
        if ((errorCode === 4 || errorCode === 32 || errorCode === 17) && retryCount < 3) {
            const delay = Math.pow(2, retryCount) * 1000;
            logger.warn('⏳ [INSTAGRAM] Rate limited by API, retrying', {
                deviceId, retryCount, delay, errorCode
            });
            await sleep(delay);
            return fetchInstagramMetrics(deviceId, account, retryCount + 1);
        }

        logger.error('❌ [INSTAGRAM] Failed to fetch metrics', {
            deviceId, errorMsg, errorCode, retryCount, apiResponseTimeMs
        });

        return {
            success: false,
            error: errorMsg,
            errorCode,
            apiResponseTimeMs,
            instagramAccountId: account.instagramAccountId,
            cacheHit: false
        };
    }
}
